// ============================================================================
// FOLLOW THE MONEY (read-only study): where does the arbitrage money on
// Robinhood Chain go?
//
// Plain English:
//   Reads the last N hours of the chain (default 6, at most 48), finds every
//   transaction that swapped in 2 or more pools, checks which of those were
//   arbitrage (the bot ended with more of some coin and less of none), puts
//   dollar values on them, and writes a plain-English report:
//     who makes the money, on which pools and exchanges, with what routes,
//     sizes and timing, and whether OUR bot watches those pools.
//
//   This script ONLY READS public chain data. It never sends a transaction,
//   never loads a key and never changes anything the bot does.
//
// How to run (on the server, from the repo folder):
//   npm run follow-money -- --hours 6
// Options:
//   --hours N     how far back to look (default 6, max 48)
//   --fresh       ignore a half-finished earlier run and start again
//   --rps N       most requests per second (default 10, or FTM_RPS)
//   --report-only rebuild the report from the saved progress (no new chain
//                 reading; coin / pool look-ups are still done if a node answers)
//   --max-minutes N  stop reading new data after about N minutes and still
//                 write the report from what was read (for CI: no external
//                 timeout needed). Time is split: swaps up to 40%, receipts
//                 up to 85%, the rest for look-ups and the report.
// Settings in .env (all optional):
//   FTM_RPC                 node to read from (else CHAINSTACK_RPC_ROBINHOOD,
//                           else ROBINHOOD_RPC_HTTP, else the public node)
//   FTM_RPS=10              requests per second
//   FTM_CONCURRENCY=4       requests in flight at once
//   FTM_BATCH=10            receipts asked for in one request (1 = no batching)
//   FTM_BIG_SWAP_USD=1000   a swap this big or bigger counts as "big" for timing
//   FTM_ETH_USD             ETH price to use if none can be seen in the swaps
// Output (in data/):
//   ftm-report-<date>.md    the report (also printed)
//   ftm-arbs-<date>.csv     one line per arbitrage trade
//   ftm-progress.json       saved progress, so a stopped run can pick up again
// ============================================================================
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import {
  ALL_SWAP_TOPICS, KIND_CODES, V4_INITIALIZE, ZERO_ADDR, ArbRecord, ClassifyReason, PriceObs, PricedArb, RawLog, SwapRow,
  buildPriceBook, buildReport, classifyTx, decodeSwapLog, obsFromSwap, priceArb, receiptGasWei, timingOf, fmtUsd,
  swapCaller, orderCandidates, KNOWN_DECIMALS, ethUsdFromSqrtPrice, ethUsdFromReserves, ReportDiag,
} from '../src/core/followMoney';
import {
  ROBINHOOD_V4, ROBINHOOD_TOKENS, ROBINHOOD_SCAN_FACTORIES, ROBINHOOD_V2, ROBINHOOD_V3, ROBINHOOD_PANCAKE, ROBINHOOD_RAMSES, ROBINHOOD_UR_COPIES,
} from '../src/config/knownAddresses';
import { ROBINHOOD_VENUES, venueByFactory } from '../src/config/robinhoodVenues';
import { ROBINHOOD_SEED_PAIRS } from '../src/config/robinhoodSeedPairs';
import { loadStartPairs } from '../src/core/seedPairs';
import { encodeAggregate3, decodeAggregate3, fastDecodeString } from '../src/core/universeScan';

const DATA = 'data';
const PROGRESS_FILE = `${DATA}/ftm-progress.json`;
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const WETH = ROBINHOOD_TOKENS.WETH.toLowerCase();
const USDG = ROBINHOOD_TOKENS.USDG.toLowerCase();
const PM = ROBINHOOD_V4.POOL_MANAGER.toLowerCase();
// Exchanges our bot can actually trade today (the executor's own kinds).
const BOT_TRADES = new Set(['uniswap-v2', 'pancakeswap-v2', 'ramses-v2', 'uniswap-v3', 'pancakeswap-v3', 'ramses-v3', 'uniswap-v4']);

// ---------------------------------------------------------------------------
// Settings from the command line and .env
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argVal = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const HOURS = Math.min(48, Math.max(0.1, Number(argVal('--hours') ?? 6) || 6));
const FRESH = argv.includes('--fresh');
const REPORT_ONLY = argv.includes('--report-only');
const RPS = Math.max(1, Number(argVal('--rps') ?? process.env.FTM_RPS ?? 10) || 10);
const CONCURRENCY = Math.max(1, Number(process.env.FTM_CONCURRENCY ?? 4) || 4);
const BATCH = Math.max(1, Math.min(50, Number(process.env.FTM_BATCH ?? 10) || 10));
const BIG_SWAP_USD = Number(process.env.FTM_BIG_SWAP_USD ?? 1_000) || 1_000;
const ETH_FALLBACK = process.env.FTM_ETH_USD ? Number(process.env.FTM_ETH_USD) : null;
const MAX_MINUTES = Number(argVal('--max-minutes') ?? 0) > 0 ? Number(argVal('--max-minutes')) : null;
// Pools with the most swaps in the sample whose coins we look up (price sources).
const BUSY_POOLS = Math.max(0, Number(process.env.FTM_BUSY_POOLS ?? 400) || 0);

// Time budget (--max-minutes): each phase stops reading new data at its share.
const T_START = Date.now();
const budgetLeft = (share: number): boolean => MAX_MINUTES === null || Date.now() - T_START < MAX_MINUTES * 60_000 * share;

// DEX routers: transactions that call pools through these are mostly normal
// user trades, so they are read last when time is short.
const ROUTERS = new Set<string>([
  ROBINHOOD_V4.UNIVERSAL_ROUTER, ...ROBINHOOD_UR_COPIES, ROBINHOOD_V3.SWAP_ROUTER_02, ROBINHOOD_V2.ROUTER,
  ROBINHOOD_PANCAKE.V2_ROUTER, ROBINHOOD_PANCAKE.SMART_ROUTER, ROBINHOOD_PANCAKE.V3_UNIVERSAL_ROUTER,
  ROBINHOOD_RAMSES.V2_ROUTER, ROBINHOOD_RAMSES.V3_SWAP_ROUTER, ROBINHOOD_RAMSES.DLMM_ROUTER, ROBINHOOD_V4.POOL_MANAGER,
].map((x) => x.toLowerCase()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => '0x' + n.toString(16);
const num = (x: any): number => { try { return Number(BigInt(x)); } catch { return NaN; } };
const lc = (x: string) => (x ?? '').toLowerCase();
const log = (m: string) => console.log(`[ftm] ${m}`);

// ---------------------------------------------------------------------------
// A small JSON-RPC client: gentle rate limit, retries with back-off, never
// prints the node address (it can contain an API key).
// ---------------------------------------------------------------------------
class SlowDown extends Error {}
class TooBig extends Error {}
class Final extends Error {}  // a real answer (e.g. the call reverted): never retried

class Rpc {
  calls = 0;                 // requests counted against the rate limit
  private tokens: number;
  private last = Date.now();
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  batchOk = true;            // turned off if the node refuses batch requests

  constructor(private readonly url: string, private readonly rps: number, private readonly maxInFlight: number) { this.tokens = rps; }

  // Error text without the node address.
  clean(e: unknown): string {
    let s = String((e as any)?.message ?? e);
    try { const u = new URL(this.url); s = s.split(this.url).join('<node>').split(u.host).join('<node>'); } catch { s = s.split(this.url).join('<node>'); }
    return s.slice(0, 300);
  }

  // Waits until `n` requests are allowed by the per-second limit.
  private async take(n: number) {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.rps, this.tokens + ((now - this.last) / 1000) * this.rps);
      this.last = now;
      if (this.tokens >= Math.min(n, this.rps)) { this.tokens -= n; return; }
      await sleep(Math.ceil(((Math.min(n, this.rps) - this.tokens) / this.rps) * 1000) + 5);
    }
  }
  private async slot() {
    if (this.inFlight < this.maxInFlight) { this.inFlight++; return; }
    await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
  }
  private release() { this.inFlight--; const w = this.waiters.shift(); if (w) w(); }

  // One HTTP POST (single call or a batch array). Throws SlowDown on rate limits.
  private async post(body: unknown, n: number, timeoutMs: number): Promise<any> {
    await this.take(n);
    await this.slot();
    this.calls += n;
    try {
      const res = await fetch(this.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) throw new SlowDown('HTTP 429');
      const text = await res.text();
      if (!res.ok) {
        if (res.status >= 500 || /rate|limit|too many/i.test(text)) throw new SlowDown(`HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      try { return JSON.parse(text); } catch { throw new Error(`bad JSON answer: ${text.slice(0, 120)}`); }
    } finally { this.release(); }
  }

  // Sorts a node error into "slow down", "ask for less" or a real error.
  private judge(err: any): Error {
    const msg = String(err?.message ?? err);
    const code = err?.code;
    if (code === -32005 && /rate|limit/i.test(msg) && !/range|results|block/i.test(msg)) return new SlowDown(msg);
    if (/rate limit|too many requests|capacity|throttl|exceeded the allowed|request limit/i.test(msg) && !/range|results|response size/i.test(msg)) return new SlowDown(msg);
    if (/revert|invalid opcode|out of gas|execution error|invalid jump/i.test(msg) || code === 3) return new Final(msg);
    if (/block range|range is too|range too|more than|too many results|response size|limit exceeded|query returned|max results|exceed|timeout|10000|Log response/i.test(msg)) return new TooBig(msg);
    return new Error(msg);
  }

  // One call, retried up to 6 times on network trouble and rate limits.
  // TooBig answers are thrown straight away (the caller asks for less).
  async call(method: string, params: unknown[], timeoutMs = 30_000): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 7; attempt++) {
      try {
        const j = await this.post({ jsonrpc: '2.0', id: 1, method, params }, 1, timeoutMs);
        if (j?.error) throw this.judge(j.error);
        return j?.result;
      } catch (e) {
        let err: any = e;
        if ((e as any)?.name === 'TimeoutError' || (e as any)?.name === 'AbortError') err = method === 'eth_getLogs' ? new TooBig('timeout') : new SlowDown('timeout');
        if (err instanceof TooBig || err instanceof Final) throw err;
        lastErr = err;
        if (attempt === 6) break;
        const wait = Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 300);
        await sleep(err instanceof SlowDown ? wait : Math.min(wait, 8_000));
      }
    }
    throw new Error(`${method} failed after retries: ${this.clean(lastErr)}`);
  }

  // Several calls in one request when the node allows it; one by one otherwise.
  // Each answer is the result, or null if that call failed.
  async many(calls: { method: string; params: unknown[] }[]): Promise<any[]> {
    if (!calls.length) return [];
    if (this.batchOk && calls.length > 1) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const j = await this.post(calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, ...c })), calls.length, 60_000);
          if (!Array.isArray(j)) { if (j?.error && /rate|limit/i.test(String(j.error.message))) throw new SlowDown('rate'); this.batchOk = false; break; }
          const out: any[] = new Array(calls.length).fill(undefined);
          let limited = 0;
          for (const r of j) {
            const i = Number(r?.id) - 1;
            if (!(i >= 0 && i < calls.length)) continue;
            // Rate-limited calls are asked again; other errors (reverts) are final.
            if (r.error) { if (/rate|limit|too many|capacity/i.test(String(r.error.message))) { limited++; out[i] = undefined; } else out[i] = null; } else out[i] = r.result;
          }
          // Calls refused for rate reasons are asked again one by one below.
          for (let i = 0; i < calls.length; i++) if (out[i] === undefined) { try { out[i] = await this.call(calls[i].method, calls[i].params); } catch { out[i] = null; } }
          if (limited) await sleep(1_000);
          return out;
        } catch (e) {
          if (e instanceof SlowDown) { await sleep(1_000 * 2 ** attempt); continue; }
          if ((e as any)?.name === 'TimeoutError') { await sleep(1_000); continue; }
          this.batchOk = false; // the node does not do batches: one by one from now on
          log(`node refused a batch request (${this.clean(e)}); asking one at a time from now on`);
          break;
        }
      }
    }
    return Promise.all(calls.map(async (c) => { try { return await this.call(c.method, c.params); } catch { return null; } }));
  }
}

// Picks the node: FTM_RPC, CHAINSTACK_RPC_ROBINHOOD, ROBINHOOD_RPC_HTTP, then
// the public node. Each is checked for chain id 4663. Only the setting NAME
// is printed, never the address.
async function pickNode(): Promise<{ rpc: Rpc; label: string }> {
  const cands: [string, string | undefined][] = [
    ['FTM_RPC', process.env.FTM_RPC], ['CHAINSTACK_RPC_ROBINHOOD', process.env.CHAINSTACK_RPC_ROBINHOOD],
    ['ROBINHOOD_RPC_HTTP', process.env.ROBINHOOD_RPC_HTTP], ['public node', PUBLIC_RPC],
  ];
  for (const [label, url] of cands) {
    if (!url || !/^https?:\/\//.test(url)) continue;
    const rpc = new Rpc(url, RPS, CONCURRENCY);
    try {
      const id = await rpc.call('eth_chainId', [], 8_000);
      if (lc(String(id)) === '0x1237') return { rpc, label };
      log(`${label} answered a different chain (${id}); skipping it`);
    } catch (e) { log(`${label} did not answer (${rpc.clean(e)}); trying the next one`); }
  }
  throw new Error('no Robinhood node answered (tried FTM_RPC, CHAINSTACK_RPC_ROBINHOOD, ROBINHOOD_RPC_HTTP and the public node)');
}

// ---------------------------------------------------------------------------
// Saved progress (so a stopped run can continue where it left off).
// ---------------------------------------------------------------------------
interface V4Info { c0: string; c1: string; hooks: string }
interface Progress {
  version: 1;
  hours: number;
  fromBlock: number; toBlock: number; fromTs: number; toTs: number;
  phase: 'logs' | 'v4' | 'receipts' | 'lookups' | 'report' | 'done';
  nextBlock: number; chunk: number;
  pools: string[];
  rows: SwapRow[];
  stats: { swaps: number; swapTxs: number; multiSwapTxs: number; multiPoolTxs: number; logCalls: number };
  cands: [string, number, number, string?][];   // [tx hash, block, tx index, main pool caller]
  order?: number[];                    // reading order of cands (most promising first)
  capped?: boolean;                    // --max-minutes cut the run short
  ethAnchor?: { usd: number; source: string } | null; // ETH price read straight from a pool
  busyLooked?: boolean;                // busiest pools' coins looked up
  candV4: string[];
  v4: Record<string, V4Info | null>;
  doneIdx: number;
  reasons: Record<string, number>;
  arbs: ArbRecord[];
  tokens: Record<string, { d: number | null; s: string | null }>;
  poolInfo: Record<string, { t0?: string; t1?: string; factory?: string } | null>;
  rpcCalls: number;
}

function saveProgress(p: Progress, rpc?: Rpc) {
  try {
    if (rpc) p.rpcCalls = rpc.calls;
    mkdirSync(DATA, { recursive: true });
    writeFileSync(PROGRESS_FILE + '.tmp', JSON.stringify(p));
    renameSync(PROGRESS_FILE + '.tmp', PROGRESS_FILE); // never a half-written file
  } catch (e) { log(`could not save progress: ${(e as Error).message}`); }
}
function loadProgress(): Progress | null {
  try { const p = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')); return p?.version === 1 ? p : null; } catch { return null; }
}

// Prints a progress line about every 10%.
function progressPrinter(label: string, total: number) {
  let nextPct = 10;
  const t0 = Date.now();
  return (done: number, extra = '') => {
    const p = total > 0 ? (100 * done) / total : 100;
    if (p + 1e-9 < nextPct && done < total) return;
    while (nextPct <= p) nextPct += 10;
    const secs = (Date.now() - t0) / 1000;
    const left = done > 0 && done < total ? Math.round((secs / done) * (total - done)) : 0;
    log(`${label}: ${Math.min(100, Math.round(p))}% (${done.toLocaleString('en-US')}/${total.toLocaleString('en-US')})${extra ? ', ' + extra : ''}${left ? `, about ${Math.ceil(left / 60)} min left` : ''}`);
  };
}

// ---------------------------------------------------------------------------
// Bot data files (read only, all optional).
// ---------------------------------------------------------------------------
interface BotFiles {
  watched: Set<string>;
  dexOfPool: Map<string, string>;
  v4FromWatch: Map<string, V4Info>;
  symbols: Map<string, string>;
  decimals: Map<string, number>;
  stables: Set<string>;
  topPairs: Set<string>;
  watchInfo: string;
  notes: string[];
  scanState: any | null;
}
const pairKey = (a: string, b: string) => [lc(a), lc(b)].sort().join('/');

function readJson(file: string): any | null {
  try { return JSON.parse(readFileSync(file, 'utf8'), (_k, v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? v.$b : v)); } catch { return null; }
}

function loadBotFiles(): BotFiles {
  const f: BotFiles = { watched: new Set(), dexOfPool: new Map(), v4FromWatch: new Map(), symbols: new Map(), decimals: new Map(), stables: new Set([USDG]), topPairs: new Set(), watchInfo: '', notes: [], scanState: null };
  // Watch list (data/watched-pools.json, saved by the bot every 10 min).
  const w = readJson(`${DATA}/watched-pools.json`);
  if (w && Array.isArray(w.pairs)) {
    for (const p of w.pairs) for (const a of p.pools ?? []) f.watched.add(lc(a));
    for (const p of w.pools ?? []) {
      const a = lc(p.poolAddress);
      f.watched.add(a);
      if (p.dex) f.dexOfPool.set(a, p.dex);
      if (p.v4) f.v4FromWatch.set(a, { c0: p.v4.native ? ZERO_ADDR : lc(p.tokenA), c1: lc(p.tokenB), hooks: lc(p.v4.hooks ?? ZERO_ADDR) });
    }
    for (const [t, m] of Object.entries<any>(w.meta ?? {})) {
      if (m?.symbol) f.symbols.set(lc(t), String(m.symbol));
      if (typeof m?.decimals === 'number') f.decimals.set(lc(t), m.decimals);
    }
    const ageH = w.savedAt ? (Date.now() - w.savedAt) / 3_600_000 : NaN;
    f.watchInfo = `data/watched-pools.json, ${w.pairs.length} pairs, ${f.watched.size} pools, saved ${isFinite(ageH) ? ageH.toFixed(1) + ' h ago' : 'at an unknown time'}`;
    if (ageH > 24) f.notes.push('The watch list file is over a day old; the "watched" columns may be out of date.');
  } else {
    f.watchInfo = 'data/watched-pools.json not found, so NO pool counts as watched (run this on the bot server)';
  }
  // Top pairs (data/robinhood-top-pairs.json, or the backup list in the repo).
  const top = loadStartPairs(`${DATA}/robinhood-top-pairs.json`, ROBINHOOD_SEED_PAIRS);
  for (const p of top.pairs) f.topPairs.add(pairKey(p.a, p.b));
  // Coin names the bot already knows.
  const sym = readJson(`${DATA}/token-symbols.json`);
  if (sym?.symbols) for (const [t, s] of Object.entries<any>(sym.symbols)) if (typeof s === 'string' && s) f.symbols.set(lc(t), s);
  // Coin groups: verified dollar coins count as $1.
  const g = readJson(`${DATA}/token-groups.json`);
  if (g?.members) for (const m of g.members) {
    if (m?.symbol) f.symbols.set(lc(m.token), m.symbol);
    if (m?.group === 'Dollars' && m.kind !== 'copy' && Math.abs((m.priceUsd ?? 1) - 1) < 0.02) f.stables.add(lc(m.token));
  }
  // Coin names from the repo's backup pair list labels ("SPY/USDG" etc.).
  for (const sp of ROBINHOOD_SEED_PAIRS) {
    const [la, lb] = (sp.label ?? '').split('/');
    if (la && !f.symbols.has(lc(sp.a))) f.symbols.set(lc(sp.a), la);
    if (lb && !f.symbols.has(lc(sp.b))) f.symbols.set(lc(sp.b), lb);
  }
  f.symbols.set(WETH, 'WETH'); f.symbols.set(USDG, 'USDG');
  for (const [t, d] of Object.entries(KNOWN_DECIMALS)) f.decimals.set(t, d);
  // Every pool on the chain the bot has found (data/robinhood-universe.json).
  const st = readJson(`${DATA}/robinhood-universe.json`);
  if (st?.version === 1 && Array.isArray(st.pools)) f.scanState = st;
  else f.notes.push('data/robinhood-universe.json not found: exchanges were looked up on chain only.');
  return f;
}

// ---------------------------------------------------------------------------
// The block range for "the last N hours" (binary search on block times).
// ---------------------------------------------------------------------------
async function blockAt(rpc: Rpc, n: number): Promise<{ number: number; ts: number }> {
  const b = await rpc.call('eth_getBlockByNumber', [hex(n), false]);
  if (!b) throw new Error(`block ${n} not found`);
  return { number: num(b.number), ts: num(b.timestamp) };
}
async function findRange(rpc: Rpc, hours: number) {
  const latestN = num(await rpc.call('eth_blockNumber', []));
  const latest = await blockAt(rpc, latestN);
  const target = latest.ts - Math.round(hours * 3600);
  let lo = Math.max(0, latestN - 5_000_000), hi = latestN;
  let loB = await blockAt(rpc, lo);
  if (loB.ts > target) { lo = 0; loB = await blockAt(rpc, 0); }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await blockAt(rpc, mid);
    if (b.ts < target) lo = mid; else hi = mid;
  }
  const first = await blockAt(rpc, hi);
  return { fromBlock: hi, toBlock: latestN, fromTs: first.ts, toTs: latest.ts };
}

// ---------------------------------------------------------------------------
// Phase 1: every swap event in the range (adaptive block chunks).
// ---------------------------------------------------------------------------
async function scanSwaps(rpc: Rpc, p: Progress) {
  const total = p.toBlock - p.fromBlock + 1;
  const show = progressPrinter('reading swaps', total);
  const poolIdx = new Map(p.pools.map((x, i) => [x, i]));
  const candSet = new Set(p.cands.map((c) => c[0]));
  const v4Set = new Set(p.candV4);
  let lastSave = Date.now();
  let slow = 0;
  while (p.nextBlock <= p.toBlock) {
    if (!budgetLeft(0.4)) {
      // Out of time for this phase: the study covers what was read so far.
      log(`time limit: stopped reading swaps at block ${(p.nextBlock - 1).toLocaleString('en-US')}`);
      const last = await blockAt(rpc, Math.max(p.fromBlock, p.nextBlock - 1)).catch(() => null);
      p.toBlock = Math.max(p.fromBlock, p.nextBlock - 1);
      if (last) p.toTs = last.ts;
      p.capped = true;
      break;
    }
    const from = p.nextBlock;
    const to = Math.min(p.toBlock, from + p.chunk - 1);
    let logs: RawLog[];
    try {
      logs = (await rpc.call('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), topics: [ALL_SWAP_TOPICS] }], 45_000)) ?? [];
      p.stats.logCalls++;
      slow = 0;
    } catch (e) {
      if (e instanceof TooBig || /TooBig/.test(String(e))) {
        if (p.chunk <= 1) throw new Error(`the node refuses even one block of logs at block ${from}: ${rpc.clean(e)}`);
        p.chunk = Math.max(1, Math.floor(p.chunk / 2));
        continue;
      }
      if (++slow > 5) throw e;
      log(`log read trouble (${rpc.clean(e)}); waiting and trying again`);
      await sleep(5_000 * slow);
      continue;
    }
    if (!Array.isArray(logs)) logs = [];
    // Group this chunk's swaps by transaction (a block is never split across chunks).
    const byTx = new Map<string, { hash: string; block: number; ti: number; swaps: number; pools: Set<string>; v4: string[]; callers: Map<string, number> }>();
    const chunkRows: SwapRow[] = [];
    for (const l of logs) {
      if ((l as any).removed) continue;
      const s = decodeSwapLog(l);
      if (!s) continue;
      const b = num(l.blockNumber), ti = num(l.transactionIndex);
      if (!isFinite(b) || !isFinite(ti)) continue;
      let pi = poolIdx.get(s.pool);
      if (pi === undefined) { pi = p.pools.push(s.pool) - 1; poolIdx.set(s.pool, pi); }
      chunkRows.push([b, ti, pi, KIND_CODES.indexOf(s.kind), s.a0 !== undefined ? s.a0.toString() : '', s.a1 !== undefined ? s.a1.toString() : '']);
      const key = `${b}:${ti}`;
      const e = byTx.get(key) ?? { hash: lc(l.transactionHash ?? ''), block: b, ti, swaps: 0, pools: new Set<string>(), v4: [], callers: new Map<string, number>() };
      e.swaps++; e.pools.add(s.pool);
      const caller = swapCaller(l);
      if (caller) e.callers.set(caller, (e.callers.get(caller) ?? 0) + 1);
      if (s.kind === 'v4') e.v4.push(s.pool);
      byTx.set(key, e);
    }
    chunkRows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const r of chunkRows) p.rows.push(r);
    p.stats.swaps += chunkRows.length;
    p.stats.swapTxs += byTx.size;
    for (const e of byTx.values()) {
      if (e.swaps >= 2) p.stats.multiSwapTxs++;
      if (e.pools.size >= 2 && e.hash && !candSet.has(e.hash)) {
        p.stats.multiPoolTxs++;
        candSet.add(e.hash);
        // Main caller: the address that called the most pools in this tx.
        const main = [...e.callers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
        p.cands.push([e.hash, e.block, e.ti, main]);
        for (const id of e.v4) if (!v4Set.has(id)) { v4Set.add(id); p.candV4.push(id); }
      }
    }
    p.nextBlock = to + 1;
    // Grow the chunk while answers stay small; shrink when they get big.
    if (logs.length < 3_000) p.chunk = Math.min(50_000, Math.ceil(p.chunk * 1.5));
    else if (logs.length > 8_000) p.chunk = Math.max(1, Math.floor(p.chunk / 2));
    show(p.nextBlock - p.fromBlock, `${p.stats.swaps.toLocaleString('en-US')} swaps, ${p.cands.length.toLocaleString('en-US')} multi-pool txs`);
    if (Date.now() - lastSave > 30_000) { saveProgress(p, rpc); lastSave = Date.now(); }
  }
}

// ---------------------------------------------------------------------------
// Phase 2: which coins each Uniswap V4 pool id holds (pool creation events).
// ---------------------------------------------------------------------------
async function lookupV4(rpc: Rpc, p: Progress, files: BotFiles) {
  for (const [id, info] of files.v4FromWatch) if (!(id in p.v4)) p.v4[id] = info;
  const todo = p.candV4.filter((id) => !(id in p.v4));
  if (!todo.length) return;
  log(`looking up ${todo.length} Uniswap V4 pools`);
  const decode = (l: RawLog): [string, V4Info] | null => {
    if (!l?.topics || l.topics.length < 4) return null;
    const hooks = '0x' + (l.data ?? '').slice(2 + 64 * 2 + 24, 2 + 64 * 3);
    return [lc(l.topics[1]), { c0: '0x' + l.topics[2].slice(26).toLowerCase(), c1: '0x' + l.topics[3].slice(26).toLowerCase(), hooks: hooks.length === 42 ? lc(hooks) : ZERO_ADDR }];
  };
  for (let i = 0; i < todo.length; i += 25) {
    const ids = todo.slice(i, i + 25);
    // Ranges to search: the whole history first, split in halves if refused.
    const stack: [number, number][] = [[0, p.toBlock]];
    let calls = 0;
    while (stack.length && calls < 80) {
      const [f, t] = stack.pop()!;
      calls++;
      try {
        const logs: RawLog[] = (await rpc.call('eth_getLogs', [{ address: ROBINHOOD_V4.POOL_MANAGER, fromBlock: hex(f), toBlock: hex(t), topics: [V4_INITIALIZE, ids] }], 45_000)) ?? [];
        for (const l of logs) { const d = decode(l); if (d) p.v4[d[0]] = d[1]; }
      } catch (e) {
        if (t - f < 1_000) continue; // give up on this slice
        const mid = Math.floor((f + t) / 2);
        stack.push([mid + 1, t], [f, mid]);
      }
    }
    for (const id of ids) if (!(id in p.v4)) p.v4[id] = null; // unknown: its plain-ETH leg can't be checked
  }
  const found = todo.filter((id) => p.v4[id]).length;
  log(`V4 pools: ${found}/${todo.length} identified`);
}

// ---------------------------------------------------------------------------
// Phase 3: read each multi-pool transaction's receipt and classify it.
// ---------------------------------------------------------------------------
async function readReceipts(rpc: Rpc, p: Progress) {
  const total = p.cands.length;
  const show = progressPrinter('checking multi-pool transactions', total);
  const v4Currencies = (id: string) => p.v4[id] ?? null;
  let lastSave = Date.now();
  const window = BATCH * CONCURRENCY;
  // Reading order: most promising first (see orderCandidates). Older saved
  // runs had no order: they keep chain order for what was already read.
  const callerOf = (i: number) => lc(p.cands[i]?.[3] ?? '');
  if (!p.order || p.order.length !== total) {
    const done = Array.from({ length: Math.min(p.doneIdx, total) }, (_, i) => i);
    const rest = Array.from({ length: total - done.length }, (_, i) => i + done.length);
    p.order = [...done, ...orderCandidates(rest, callerOf, ROUTERS, new Map())];
  }
  // Pool callers proven to be arbitrage bots in this run (caller -> arbs).
  const proven = new Map<string, number>();
  const callerByHash = new Map(p.cands.map((c) => [c[0], lc(c[3] ?? '')]));
  for (const a of p.arbs) { const c = callerByHash.get(a.hash); if (c) proven.set(c, (proven.get(c) ?? 0) + 1); }
  let provenAtSort = proven.size;
  while (p.doneIdx < total) {
    if (!budgetLeft(0.85)) {
      log(`time limit: stopped after ${p.doneIdx.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} multi-pool transactions (most promising first)`);
      p.capped = true;
      break;
    }
    // New bots proven since the last sort: move their other trades forward.
    if (proven.size > provenAtSort) {
      p.order = [...p.order.slice(0, p.doneIdx), ...orderCandidates(p.order.slice(p.doneIdx), callerOf, ROUTERS, proven)];
      provenAtSort = proven.size;
    }
    const slice = p.order.slice(p.doneIdx, p.doneIdx + window).map((i) => p.cands[i]);
    const groups: [string, number, number, string?][][] = [];
    for (let i = 0; i < slice.length; i += BATCH) groups.push(slice.slice(i, i + BATCH));
    const results = await Promise.all(groups.map((g) => rpc.many(g.map((c) => ({ method: 'eth_getTransactionReceipt', params: [c[0]] })))));
    const found: ArbRecord[] = [];
    groups.forEach((g, gi) => g.forEach((c, ci) => {
      const r = results[gi][ci];
      let reason: ClassifyReason | 'no-receipt' = 'no-receipt';
      if (r && r.logs) {
        const gas = receiptGasWei(r);
        const res = classifyTx(r.logs, r.from, r.to, r.status, { hash: c[0], block: c[1], txIndex: c[2], ...gas }, { poolManager: PM, weth: WETH, v4Currencies });
        reason = res.reason;
        if (res.arb) {
          found.push(res.arb);
          const caller = lc(c[3] ?? '');
          if (caller && !ROUTERS.has(caller)) proven.set(caller, (proven.get(caller) ?? 0) + 1);
        }
      }
      p.reasons[reason] = (p.reasons[reason] ?? 0) + 1;
    }));
    // The transaction itself, for arbitrage only (plain ETH it carried).
    if (found.length) {
      const txs = await rpc.many(found.map((a) => ({ method: 'eth_getTransactionByHash', params: [a.hash] })));
      found.forEach((a, i) => {
        const v = txs[i]?.value;
        if (v !== undefined && v !== null) { try { a.value = BigInt(v).toString(); } catch { /* leave it out */ } }
        if (a.value && a.value !== '0' && !a.uncertain.includes('native-eth-sent')) a.uncertain.push('native-eth-sent');
      });
      for (const a of found) p.arbs.push(a);
    }
    p.doneIdx += slice.length;
    show(p.doneIdx, `${p.arbs.length.toLocaleString('en-US')} arbitrage so far`);
    if (Date.now() - lastSave > 30_000) { saveProgress(p, rpc); lastSave = Date.now(); }
  }
}

// ---------------------------------------------------------------------------
// Phase 4: coin decimals / names and pool coins / factory (bundled reads).
// ---------------------------------------------------------------------------

// One read per call, sent in batches when the node allows (null = failed).
async function singles(rpc: Rpc, calls: { target: string; data: string }[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += BATCH) {
    const res = await rpc.many(calls.slice(i, i + BATCH).map((c) => ({ method: 'eth_call', params: [{ to: c.target, data: c.data }, 'latest'] })));
    for (const r of res) out.push(typeof r === 'string' && r !== '0x' ? r : null);
  }
  return out;
}

// Many contract reads. Uses Multicall3 when it exists, but any bundle whose
// answer can't be read (error, empty "0x", wrong length, or every answer
// empty) is asked again one call at a time, so a node quirk never turns into
// "no decimals / no coins" for everything (Oct 16 fix).
async function callMany(rpc: Rpc, calls: { target: string; data: string }[], useMulticall: boolean): Promise<(string | null)[]> {
  if (!useMulticall) return singles(rpc, calls);
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += 200) {
    const slice = calls.slice(i, i + 200);
    let dec: (string | null)[] | null = null;
    try {
      const ret = await rpc.call('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(slice) }, 'latest']);
      if (typeof ret === 'string' && ret.length > 2) dec = decodeAggregate3(ret);
    } catch { dec = null; }
    if (!dec || dec.length !== slice.length || (slice.length >= 3 && dec.every((x) => !x))) dec = await singles(rpc, slice);
    for (const d of dec) out.push(d ?? null);
  }
  return out;
}

const SEL = { decimals: '0x313ce567', symbol: '0x95d89b41', token0: '0x0dfe1681', token1: '0xd21220a7', factory: '0xc45a0155' };
const asAddr = (r: string | null) => (r && r.length >= 66 ? '0x' + r.slice(26, 66).toLowerCase() : undefined);
const asUint = (r: string | null): number | null => { if (!r || r.length < 66) return null; try { const v = Number(BigInt(r.slice(0, 66))); return v <= 255 ? v : null; } catch { return null; } };

const word = (addr: string) => addr.slice(2).toLowerCase().padStart(64, '0');
const SEL2 = { getPool: '0x1698ee82', getPair: '0xe6a43905', slot0: '0x3850c7bd', getReserves: '0x0902f1ac', balanceOf: '0x70a08231' };

// ETH price read straight from the deepest WETH/USDG pool among the repo's
// known factories (Uniswap / PancakeSwap V3 fee tiers, Uniswap / PancakeSwap
// V2), so the report never shows "ETH price: ?" (Oct 16 fix). The pool with
// the most USDG in it wins.
async function readEthAnchor(rpc: Rpc, useMc: boolean): Promise<{ usd: number; source: string } | null> {
  const pair = word(WETH) + word(USDG);
  const ask: { target: string; data: string; kind: 'v3' | 'v2'; label: string }[] = [];
  for (const [label, factory, fees] of [['Uniswap V3', ROBINHOOD_V3.FACTORY, [100, 500, 3000, 10000]], ['PancakeSwap V3', ROBINHOOD_PANCAKE.V3_FACTORY, [100, 500, 2500, 10000]]] as [string, string, number[]][]) {
    for (const fee of fees) ask.push({ target: factory, data: SEL2.getPool + pair + fee.toString(16).padStart(64, '0'), kind: 'v3', label: `${label} ${fee / 10000}%` });
  }
  for (const [label, factory] of [['Uniswap V2', ROBINHOOD_V2.FACTORY], ['PancakeSwap V2', ROBINHOOD_PANCAKE.V2_FACTORY]] as [string, string][]) {
    ask.push({ target: factory, data: SEL2.getPair + pair, kind: 'v2', label });
  }
  const found = await callMany(rpc, ask.map(({ target, data }) => ({ target, data })), useMc);
  const pools = ask.map((a, i) => ({ ...a, pool: asAddr(found[i]) })).filter((x) => x.pool && x.pool !== ZERO_ADDR) as (typeof ask[number] & { pool: string })[];
  if (!pools.length) return null;
  const reads = await callMany(rpc, pools.flatMap((x) => [
    { target: USDG, data: SEL2.balanceOf + word(x.pool) },
    { target: x.pool, data: x.kind === 'v3' ? SEL2.slot0 : SEL2.getReserves },
  ]), useMc);
  let best: { usd: number; source: string; depth: number } | null = null;
  const wethIs0 = WETH < USDG; // token0 = the lower address
  pools.forEach((x, i) => {
    const bal = reads[2 * i], st = reads[2 * i + 1];
    if (!bal || !st || st.length < 130) return;
    const depth = Number(BigInt(bal.slice(0, 66))) / 1e6;
    let usd: number | null = null;
    if (x.kind === 'v3') usd = ethUsdFromSqrtPrice(BigInt(st.slice(0, 66)), wethIs0);
    else {
      const r0 = BigInt('0x' + st.slice(2, 66)), r1 = BigInt('0x' + st.slice(66, 130));
      usd = wethIs0 ? ethUsdFromReserves(r0, r1) : ethUsdFromReserves(r1, r0);
    }
    if (usd !== null && usd > 10 && usd < 1e6 && (!best || depth > best.depth)) best = { usd, depth, source: `${x.label} WETH/USDG pool ${x.pool.slice(0, 10)} (holds ${fmtUsd(depth)} USDG)` };
  });
  return best ? { usd: (best as any).usd, source: (best as any).source } : null;
}

// Pools whose coins we need: every arbitrage pool, plus the busiest pools in
// the sample (they are where most prices come from). Without the bot's scan
// file NOTHING else tells us a pool's coins (the Oct 16 "priced none" run).
function poolsToLookUp(p: Progress, scanPools: Map<string, unknown>): { arb: string[]; busy: string[] } {
  const known = (x: string) => scanPools.has(x) || x in p.poolInfo || x.length !== 42;
  const arb = new Set<string>();
  for (const a of p.arbs) for (const x of a.pools) if (!known(x)) arb.add(x);
  const counts = new Map<number, number>();
  for (const r of p.rows) counts.set(r[2], (counts.get(r[2]) ?? 0) + 1);
  const busy = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => p.pools[i])
    .filter((x) => x && !known(x) && !arb.has(x)).slice(0, BUSY_POOLS);
  return { arb: [...arb], busy };
}

async function lookups(rpc: Rpc, p: Progress, files: BotFiles, scanPools: Map<string, { dex: string; t0: string; t1: string }>) {
  let useMc = false;
  try { const code = await rpc.call('eth_getCode', [MULTICALL3, 'latest']); useMc = typeof code === 'string' && code.length > 2; } catch { /* single calls */ }
  log(`reads: ${useMc ? 'bundled (Multicall3)' : 'one by one (no Multicall3)'}`);
  // Pools: coins and exchange.
  const { arb, busy } = poolsToLookUp(p, scanPools);
  const pl = [...arb, ...busy];
  if (pl.length) {
    log(`looking up ${pl.length} pools (${arb.length} in arbitrage routes, ${busy.length} busiest), coins and exchange`);
    const res = await callMany(rpc, pl.flatMap((x) => [{ target: x, data: SEL.token0 }, { target: x, data: SEL.token1 }, { target: x, data: SEL.factory }]), useMc);
    pl.forEach((x, i) => { p.poolInfo[x] = { t0: asAddr(res[3 * i]), t1: asAddr(res[3 * i + 1]), factory: asAddr(res[3 * i + 2]) }; });
  }
  // Coins in arbitrage trades (their decimals and names).
  const toks = new Set<string>([WETH, USDG]);
  for (const a of p.arbs) {
    for (const [t] of a.net) toks.add(t);
    for (const [t] of a.outflow) toks.add(t);
    for (const h of a.hops) { if (h.tin) toks.add(h.tin); if (h.tout) toks.add(h.tout); }
  }
  // Known decimals never need a read; earlier failed reads are tried again.
  const tl = [...toks].filter((t) => t.length === 42 && (!(t in p.tokens) || p.tokens[t].d === null || p.tokens[t].d === undefined));
  for (const t of tl) if (KNOWN_DECIMALS[t] !== undefined) p.tokens[t] = { d: KNOWN_DECIMALS[t], s: files.symbols.get(t) ?? null };
  const ask = tl.filter((t) => KNOWN_DECIMALS[t] === undefined);
  if (ask.length) {
    log(`looking up ${ask.length} coins (decimals and names)`);
    const res = await callMany(rpc, ask.flatMap((t) => [{ target: t, data: SEL.decimals }, { target: t, data: SEL.symbol }]), useMc);
    ask.forEach((t, i) => {
      const s = fastDecodeString(res[2 * i + 1]);
      p.tokens[t] = { d: files.decimals.get(t) ?? asUint(res[2 * i]), s: files.symbols.get(t) ?? (s ? s.replace(/[^\x20-\x7e]/g, '').slice(0, 16) || null : null) };
    });
  }
  // ETH price straight from a pool (used when the sample has no WETH/USDG swaps we can read).
  if (!p.ethAnchor) {
    try { p.ethAnchor = await readEthAnchor(rpc, useMc); } catch (e) { log(`could not read an ETH price from a pool: ${rpc.clean(e)}`); }
    log(p.ethAnchor ? `ETH price from a pool: ${fmtUsd(p.ethAnchor.usd)}` : 'no ETH price from a pool');
  }
}

// ---------------------------------------------------------------------------
// Phase 5: prices, the report and the CSV.
// ---------------------------------------------------------------------------
function exchangeOfFactory(factory?: string): string | null {
  if (!factory) return null;
  const f = lc(factory);
  const known = ROBINHOOD_SCAN_FACTORIES.find((x) => lc(x.factory) === f);
  if (known) return known.dex;
  const v = venueByFactory(f);
  return v ? v.id : null;
}
function dexSupport(dex: string): string {
  if (BOT_TRADES.has(dex)) return 'trades';
  const v = ROBINHOOD_VENUES.find((x) => x.id === dex);
  if (v?.practiceTested) return 'practice only';
  if (v?.priceable) return 'reads prices only';
  if (v) return 'no';
  return 'no (unknown exchange)';
}

function makeReport(p: Progress, files: BotFiles, scanPools: Map<string, { dex: string; t0: string; t1: string }>) {
  // Decimals: the repo's known coins first (WETH 18, USDG 6), then look-ups, then bot files.
  const tokenDec = (t: string): number | null => KNOWN_DECIMALS[t] ?? p.tokens[t]?.d ?? files.decimals.get(t) ?? null;
  const symbol = (t: string): string => p.tokens[t]?.s ?? files.symbols.get(t) ?? (t ? t.slice(0, 8) : '?');
  const poolTokens = (pool: string): { t0: string; t1: string } | null => {
    const s = scanPools.get(pool);
    if (s) return s;
    const i = p.poolInfo[pool];
    if (i?.t0 && i?.t1) return { t0: i.t0, t1: i.t1 };
    const v = p.v4[pool];
    if (v) return { t0: v.c0 === ZERO_ADDR ? WETH : v.c0, t1: v.c1 === ZERO_ADDR ? WETH : v.c1 };
    return null;
  };
  const dexOf = (pool: string): string => {
    const d = files.dexOfPool.get(pool) ?? scanPools.get(pool)?.dex;
    if (d) return d;
    if (pool.length === 66) {
      const v = p.v4[pool];
      return v && v.hooks !== ZERO_ADDR ? 'uniswap-v4-hooked' : 'uniswap-v4';
    }
    const ex = exchangeOfFactory(p.poolInfo[pool]?.factory);
    return ex ?? (p.poolInfo[pool]?.factory ? `unknown (factory ${p.poolInfo[pool]!.factory!.slice(0, 10)})` : 'unknown');
  };

  // Price observations: every swap on a pool with known coins that trades
  // against USDG / a dollar coin / WETH, for coins we need, plus the hops of
  // the arbitrage trades themselves.
  const isQuote = (t: string) => files.stables.has(t) || t === WETH;
  const need = new Set<string>([WETH]);
  for (const a of p.arbs) { for (const [t] of a.net) need.add(t); for (const [t] of a.outflow) need.add(t); for (const h of a.hops) { if (h.tin) need.add(h.tin); if (h.tout) need.add(h.tout); } }
  const obs: PriceObs[] = [];
  const tokCache = new Map<number, { t0: string; t1: string } | null>();
  const tokensOfIdx = (i: number) => { if (!tokCache.has(i)) tokCache.set(i, poolTokens(p.pools[i])); return tokCache.get(i)!; };
  for (const r of p.rows) {
    if (!r[4] || !r[5]) continue;
    const tk = tokensOfIdx(r[2]);
    if (!tk) continue;
    if (!(need.has(tk.t0) && isQuote(tk.t1)) && !(need.has(tk.t1) && isQuote(tk.t0))) continue;
    const d0 = tokenDec(tk.t0), d1 = tokenDec(tk.t1);
    if (d0 === null || d1 === null) continue;
    for (const o of obsFromSwap(r[0], p.pools[r[2]], tk.t0, tk.t1, BigInt(r[4]), BigInt(r[5]), d0, d1, isQuote)) obs.push(o);
  }
  for (const a of p.arbs) for (const h of a.hops) {
    if (!h.tin || !h.tout || !h.ain || !h.aout) continue;
    const d0 = tokenDec(h.tin), d1 = tokenDec(h.tout);
    if (d0 === null || d1 === null) continue;
    for (const o of obsFromSwap(a.block, h.pool, h.tin, h.tout, BigInt(h.ain), -BigInt(h.aout), d0, d1, isQuote)) obs.push(o);
  }
  // ETH: swaps in the sample first; else the price read from a pool; else FTM_ETH_USD.
  const ethObs = obs.filter((o) => o.token === WETH && files.stables.has(o.quote)).length;
  const ethFallback = p.ethAnchor?.usd ?? ETH_FALLBACK;
  const book = buildPriceBook(obs, files.stables, WETH, { ethFallbackUsd: ethFallback });
  const ethSource = ethObs ? `WETH swaps against dollar coins in the sample (${ethObs.toLocaleString('en-US')})`
    : p.ethAnchor ? `read from a pool: ${p.ethAnchor.source}`
    : ETH_FALLBACK ? 'the FTM_ETH_USD setting'
    : 'NONE: no readable WETH/USDG swaps and no pool answered (set FTM_ETH_USD to force one)';

  // Dollar size of any swap row (for "after a big swap").
  const poolIdx = new Map(p.pools.map((x, i) => [x, i]));
  const swapUsd = (r: SwapRow): number | null => {
    if (!r[4] || !r[5]) return null;
    const tk = tokensOfIdx(r[2]);
    if (!tk) return null;
    let best: number | null = null;
    for (const [t, a] of [[tk.t0, r[4]], [tk.t1, r[5]]] as [string, string][]) {
      const d = tokenDec(t), px = book.usdAt(t, r[0]);
      if (d === null || !px) continue;
      const v = Math.abs(Number(BigInt(a))) / 10 ** d * px.usd;
      best = Math.max(best ?? 0, v);
    }
    return best;
  };
  // Block time estimate (straight line between the first and last block).
  const span = Math.max(1, p.toBlock - p.fromBlock);
  const timeOf = (b: number) => (p.fromTs + ((b - p.fromBlock) / span) * (p.toTs - p.fromTs)) * 1000;

  const priced: PricedArb[] = p.arbs.map((a) => priceArb(a, {
    book, decimals: tokenDec, symbol, dexOf,
    isWatched: (pool) => files.watched.has(pool),
    botCanTrade: (d) => BOT_TRADES.has(d),
    timeOf, weth: WETH,
    timing: (rec) => timingOf(rec, p.rows, (x) => poolIdx.get(x), swapUsd, BIG_SWAP_USD),
  }));

  const pairOf = (pool: string) => {
    const tk = poolTokens(pool);
    if (!tk) return '?';
    const name = `${symbol(tk.t0)}/${symbol(tk.t1)}`;
    return files.topPairs.has(pairKey(tk.t0, tk.t1)) ? `${name} (pair on our top list)` : name;
  };
  const notes = [...files.notes];
  const v4Unknown = p.candV4.filter((id) => !p.v4[id]).length;
  if (v4Unknown) notes.push(`${v4Unknown} Uniswap V4 pools could not be identified; trades through them may be counted as "user-swap" when their plain-ETH leg was hidden.`);
  notes.push(`RPC requests used: about ${p.rpcCalls.toLocaleString('en-US')}.`);
  const dateLabel = new Date(p.toTs * 1000).toISOString().slice(0, 10);
  const midBlock = Math.floor((p.fromBlock + p.toBlock) / 2);
  // Diagnostics: how far the look-ups got.
  const arbPools = new Set<string>();
  for (const a of p.arbs) for (const x of a.pools) arbPools.add(x);
  const counts = new Map<number, number>();
  for (const r of p.rows) counts.set(r[2], (counts.get(r[2]) ?? 0) + 1);
  const busyTop = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, BUSY_POOLS).map(([i]) => p.pools[i]);
  const poolsNeeded = new Set([...arbPools, ...busyTop]);
  const coinsNeeded = [...need].filter((t) => t && t.length === 42);
  const diag: ReportDiag = {
    coinsNeeded: coinsNeeded.length, coinsWithDecimals: coinsNeeded.filter((t) => tokenDec(t) !== null).length,
    poolsNeeded: poolsNeeded.size, poolsWithTokens: [...poolsNeeded].filter((x) => poolTokens(x) !== null).length,
    priceObs: obs.length, ethObs, ethSource,
    coverage: `read ${p.doneIdx.toLocaleString('en-US')} of ${p.cands.length.toLocaleString('en-US')} multi-pool transactions`
      + (p.doneIdx < p.cands.length ? ' (most promising first: known repeat bots before router trades), so totals are a LOWER bound' : '')
      + (p.capped ? `; the --max-minutes limit cut the run short` : ''),
  };
  const rep = buildReport({
    dateLabel, fromBlock: p.fromBlock, toBlock: p.toBlock, fromMs: p.fromTs * 1000, toMs: p.toTs * 1000,
    swaps: p.stats.swaps, swapTxs: p.stats.swapTxs, multiSwapTxs: p.stats.multiSwapTxs, multiPoolTxs: p.stats.multiPoolTxs,
    checked: p.doneIdx, reasons: p.reasons, arbs: priced, pairOf, dexSupport, watchInfo: files.watchInfo,
    ethUsd: book.ethAt(midBlock), bigSwapUsd: BIG_SWAP_USD, notes, diag,
  });
  return { ...rep, dateLabel };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const t0 = Date.now();
  mkdirSync(DATA, { recursive: true });
  const files = loadBotFiles();
  let p = FRESH ? null : loadProgress();
  let rpc: Rpc | null = null;

  if (REPORT_ONLY) {
    if (!p) throw new Error('no saved progress to report on (data/ftm-progress.json)');
    // No new chain reading, but coin / pool look-ups still run if a node
    // answers: a run stopped early never got to them, and without them
    // nothing can be priced (the Oct 16 "priced none" run).
    if (p.phase !== 'report' && p.phase !== 'done') {
      try { rpc = (await pickNode()).rpc; rpc.calls = p.rpcCalls ?? 0; } catch { log('no node answered: building the report without look-ups'); }
      if (rpc) p.phase = 'lookups';
    }
  } else {
    const node = await pickNode();
    rpc = node.rpc;
    log(`reading from: ${node.label} (address not shown), up to ${RPS} requests/s`);
    if (p && p.phase !== 'done' && Math.abs(p.hours - HOURS) < 1e-9) {
      log(`continuing the unfinished run from ${PROGRESS_FILE} (phase: ${p.phase}); use --fresh to start over`);
      rpc.calls = p.rpcCalls ?? 0;
    } else {
      const range = await findRange(rpc, HOURS);
      p = {
        version: 1, hours: HOURS, ...range, phase: 'logs', nextBlock: range.fromBlock, chunk: 2_000,
        pools: [], rows: [], stats: { swaps: 0, swapTxs: 0, multiSwapTxs: 0, multiPoolTxs: 0, logCalls: 0 },
        cands: [], candV4: [], v4: {}, doneIdx: 0, reasons: {}, arbs: [], tokens: {}, poolInfo: {}, rpcCalls: rpc.calls,
      };
      log(`period: last ${HOURS} h = blocks ${range.fromBlock.toLocaleString('en-US')} to ${range.toBlock.toLocaleString('en-US')} (${(range.toBlock - range.fromBlock + 1).toLocaleString('en-US')} blocks)`);
      saveProgress(p, rpc);
    }
    if (p.phase === 'logs') { await scanSwaps(rpc, p); p.phase = 'v4'; saveProgress(p, rpc); }
    log(`swaps: ${p.stats.swaps.toLocaleString('en-US')}, multi-pool transactions to check: ${p.cands.length.toLocaleString('en-US')}`);
    if (p.phase === 'v4') { if (budgetLeft(0.5)) await lookupV4(rpc, p, files); p.phase = 'receipts'; saveProgress(p, rpc); }
    if (p.phase === 'receipts') { await readReceipts(rpc, p); p.phase = 'lookups'; saveProgress(p, rpc); }
  }

  // Pools the bot's chain-wide scan already knows (only the ones we need).
  const scanPools = new Map<string, { dex: string; t0: string; t1: string }>();
  if (files.scanState) {
    const wanted = new Set(p!.pools);
    const st = files.scanState;
    for (const row of st.pools as [number, string, number, number][]) {
      const pool = lc(row[1]);
      if (!wanted.has(pool)) continue;
      const [dex] = String(st.factories[row[0]] ?? '').split('|');
      scanPools.set(pool, { dex: dex || 'unknown', t0: lc(st.tokens[row[2]]), t1: lc(st.tokens[row[3]]) });
    }
    files.scanState = null; // free the memory
  }
  if (rpc && p!.phase === 'lookups') {
    try { await lookups(rpc, p!, files, scanPools); }
    catch (e) { log(`look-ups stopped early (${rpc.clean(e)}); the report uses what was found`); }
    p!.phase = 'report'; saveProgress(p!, rpc);
  }

  const rep = makeReport(p!, files, scanPools);
  const mdFile = `${DATA}/ftm-report-${rep.dateLabel}.md`;
  const csvFile = `${DATA}/ftm-arbs-${rep.dateLabel}.csv`;
  writeFileSync(mdFile, rep.md);
  writeFileSync(csvFile, rep.csv);
  console.log('\n' + rep.md);
  if (p!.phase !== 'done') { p!.phase = 'done'; saveProgress(p!, rpc ?? undefined); }
  log(`done in ${Math.round((Date.now() - t0) / 60_000)} min, ${(rpc?.calls ?? p!.rpcCalls).toLocaleString('en-US')} requests. Kept after gas: ${fmtUsd(rep.totals.netUsd)} (${fmtUsd(rep.totals.perDayUsd)}/day).`);
  log(`wrote ${mdFile} and ${csvFile}`);
  if (existsSync(PROGRESS_FILE)) log(`progress kept in ${PROGRESS_FILE} (run again with --report-only to rebuild the report)`);
  process.exit(0);
})().catch((e) => {
  // Error text only; node addresses are never part of what we print.
  console.error(`[ftm] stopped: ${String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, '<node>')}`);
  console.error('[ftm] progress is saved; run the same command again to continue.');
  process.exit(1);
});
