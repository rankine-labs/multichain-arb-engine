// ============================================================================
// PROFIT MEASURE (read-only research): how much arbitrage profit is really
// available on Robinhood Chain, who takes it, how big, how fast.
//
// Plain English:
//   1. Reads every swap event of the last PM_HOURS hours (default 24) from the
//      public node, in block order.
//   2. Works out which coins every pool holds and which exchange made it.
//   3. Reads the receipt of transactions that swapped in 2+ pools ("maybe
//      arbitrage"), the pools our bot can trade first (all of them), the rest
//      as a random sample, and checks each with the bot's own arbitrage
//      detector (src/core/followMoney.ts classifyTx).
//   4. Census: for a recent stretch of blocks it reads EVERY receipt in the
//      block (eth_getBlockReceipts), so failed attempts (ours and rivals')
//      become visible too.
//   5. Writes results/profit-measure/arbs.jsonl (one line per arbitrage),
//      census.json, our-bot.json and summary.json for the report step.
//
// Safety: reads public chain data only. Never loads a key, never signs or
// sends anything, never touches the bot server.
//
// Settings (environment):
//   PM_RPC            node (default: the public Robinhood node)
//   PM_HOURS=24       look-back window
//   PM_RPS=6          starting requests per second (adapts down on 429)
//   PM_MAX_RPS=12     ceiling for the adaptive rate
//   PM_BATCH=20       calls per batched request
//   PM_RECEIPT_MIN=150  minutes allowed for the receipts phase
//   PM_CENSUS_MIN=60    minutes allowed for the census phase
// ============================================================================
import { writeFileSync, mkdirSync, appendFileSync } from 'fs';
import {
  ALL_SWAP_TOPICS, V4_INITIALIZE, ZERO_ADDR, ArbRecord, RawLog, PriceObs,
  buildPriceBook, classifyTx, decodeSwapLog, obsFromSwap, receiptGasWei,
} from '../../src/core/followMoney';
import { ROBINHOOD_V4, ROBINHOOD_TOKENS, ROBINHOOD_SCAN_FACTORIES } from '../../src/config/knownAddresses';
import { venueByFactory } from '../../src/config/robinhoodVenues';
import { encodeAggregate3, decodeAggregate3, fastDecodeString } from '../../src/core/universeScan';

// ---------------------------------------------------------------------------
// Settings and constants
// ---------------------------------------------------------------------------
const RPC_URL = process.env.PM_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const HOURS = Number(process.env.PM_HOURS ?? 24);
const START_RPS = Number(process.env.PM_RPS ?? 6);
const MAX_RPS = Number(process.env.PM_MAX_RPS ?? 12);
const BATCH = Number(process.env.PM_BATCH ?? 20);
const RECEIPT_MIN = Number(process.env.PM_RECEIPT_MIN ?? 150);
const CENSUS_MIN = Number(process.env.PM_CENSUS_MIN ?? 60);
const OUT = 'results/profit-measure';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const WETH = ROBINHOOD_TOKENS.WETH.toLowerCase();
const USDG = ROBINHOOD_TOKENS.USDG.toLowerCase();
const PM = ROBINHOOD_V4.POOL_MANAGER.toLowerCase();
const OUR_SENDER = '0x09b4fb908ff646afa9c9878c082add7e4b3784d6';
const OUR_EXEC = '0x7e0f847dd429e7c15ab08686d28710389c1f7837';

// Exchanges the DEPLOYED executor can trade today: the core ones, plus the
// fork-tested copy exchanges that go live after the contract-match check.
// Left out: Algebra (alandale, kittenswap) and hooked V4 (fables) - the
// deployed contract lacks those callbacks/hop kinds (robinhoodVenues.ts).
const TRADEABLE = new Set([
  'uniswap-v2', 'pancakeswap-v2', 'ramses-v2', 'uniswap-v3', 'pancakeswap-v3', 'ramses-v3', 'uniswap-v4',
  'giga-cl', 'up-cl', 'swaphood-v3', 'topaz-cl', 'raphael-cl', 'sushiswap-v3', 'abyss-cl',
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => '0x' + n.toString(16);
const num = (x: any): number => { try { return Number(BigInt(x)); } catch { return NaN; } };
const lc = (x: string) => String(x ?? '').toLowerCase();
const T0 = Date.now();
const log = (m: string) => console.log(`[pm ${((Date.now() - T0) / 60000).toFixed(1)}m] ${m}`);

// ---------------------------------------------------------------------------
// A polite JSON-RPC client: adaptive requests/second (slows down on 429,
// speeds up slowly when quiet), batching, retries with back-off.
// ---------------------------------------------------------------------------
class Rpc {
  rps = START_RPS;
  http = 0;          // HTTP requests sent
  calls = 0;         // JSON-RPC calls inside them
  limited = 0;       // 429 answers seen
  private next = Date.now();
  private lastLimit = Date.now();
  constructor(private url: string) {
    // Every 30 s without a 429, allow a little more speed.
    setInterval(() => { if (Date.now() - this.lastLimit > 30_000) this.rps = Math.min(MAX_RPS, this.rps + 0.5); }, 30_000).unref();
  }
  private onLimit() { this.limited++; this.lastLimit = Date.now(); this.rps = Math.max(1, this.rps * 0.7); this.next = Date.now() + 2_000; }
  // Waits for the next free slot (requests are spaced 1/rps apart).
  private async slot() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + 1000 / this.rps;
    if (at > now) await sleep(at - now);
  }
  private async post(body: unknown, timeout: number): Promise<any> {
    await this.slot();
    this.http++;
    const r = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const txt = await r.text();
    if (r.status === 429) { this.onLimit(); throw new Error('429'); }
    let j: any;
    try { j = JSON.parse(txt); } catch { if (r.status >= 500) throw new Error(`HTTP ${r.status}`); throw new Error(`bad answer HTTP ${r.status}: ${txt.slice(0, 120)}`); }
    if (!Array.isArray(j) && j?.error && (j.error.code === 429 || /too many/i.test(j.error.message ?? ''))) { this.onLimit(); throw new Error('429'); }
    return j;
  }
  // One call; throws {rangeError:true} for "ask for less" answers.
  async call(method: string, params: unknown[], timeout = 45_000): Promise<any> {
    let last: any;
    for (let a = 0; a < 8; a++) {
      try {
        this.calls++;
        const j = await this.post({ jsonrpc: '2.0', id: 1, method, params }, timeout);
        if (j.error) {
          const m = String(j.error.message ?? '');
          if (/exceeds limit|range|too many results|response size|query returned/i.test(m)) { const e: any = new Error(m); e.rangeError = true; throw e; }
          throw new Error(m.slice(0, 200));
        }
        return j.result;
      } catch (e: any) {
        if (e?.rangeError) throw e;
        last = e;
        if (e?.name === 'TimeoutError' && method === 'eth_getLogs') { const x: any = new Error('timeout'); x.rangeError = true; throw x; }
        await sleep(Math.min(20_000, 500 * 2 ** a));
      }
    }
    throw new Error(`${method} failed: ${String(last?.message ?? last).slice(0, 200)}`);
  }
  // Many calls in batched requests; answer per call (null when it failed).
  async many(calls: { method: string; params: unknown[] }[], timeout = 60_000): Promise<any[]> {
    const out: any[] = new Array(calls.length).fill(undefined);
    for (let i = 0; i < calls.length; i += BATCH) {
      const part = calls.slice(i, i + BATCH);
      let done = false;
      for (let a = 0; a < 6 && !done; a++) {
        try {
          this.calls += part.length;
          const j = await this.post(part.map((c, k) => ({ jsonrpc: '2.0', id: k + 1, ...c })), timeout);
          if (!Array.isArray(j)) throw new Error('not a batch answer');
          let lim = 0;
          for (const r of j) {
            const k = Number(r?.id) - 1;
            if (!(k >= 0 && k < part.length)) continue;
            if (r.error) { if (r.error.code === 429 || /too many/i.test(r.error.message ?? '')) lim++; continue; }
            out[i + k] = r.result ?? null;
          }
          if (lim) this.onLimit();
          done = true;
        } catch { await sleep(Math.min(20_000, 1_000 * 2 ** a)); }
      }
      // Anything still missing: one by one.
      for (let k = 0; k < part.length; k++) if (out[i + k] === undefined) {
        try { out[i + k] = await this.call(part[k].method, part[k].params, timeout); } catch { out[i + k] = null; }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Data kept from the swap scan (struct of arrays to keep memory small).
// ---------------------------------------------------------------------------
const pools: string[] = [];                 // pool address / V4 id by index
const poolIdx = new Map<string, number>();
const R = { block: [] as number[], ti: [] as number[], pool: [] as number[], a0: [] as number[], a1: [] as number[] };
interface Cand { hash: string; block: number; ti: number; pools: number[] }
const cands: Cand[] = [];
const blockTs = new Map<number, number>();  // a few sampled block times

function poolId(p: string): number { let i = poolIdx.get(p); if (i === undefined) { i = pools.push(p) - 1; poolIdx.set(p, i); } return i; }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  mkdirSync(OUT, { recursive: true });
  const rpc = new Rpc(RPC_URL);
  const chain = await rpc.call('eth_chainId', []);
  if (lc(chain) !== '0x1237') throw new Error(`wrong chain ${chain}`);

  // ---- 0. Window and our bot's starting nonce ------------------------------
  const startHead = num(await rpc.call('eth_blockNumber', []));
  const bHead = await rpc.call('eth_getBlockByNumber', [hex(startHead), false]);
  const bOld = await rpc.call('eth_getBlockByNumber', [hex(startHead - 200_000), false]);
  const bps = 200_000 / (num(bHead.timestamp) - num(bOld.timestamp));
  let fromBlock = startHead - Math.round(HOURS * 3600 * bps);
  const bFrom = await rpc.call('eth_getBlockByNumber', [hex(fromBlock), false]);
  // One correction step so the window is HOURS long by the chain's clock.
  fromBlock += Math.round(((num(bHead.timestamp) - HOURS * 3600) - num(bFrom.timestamp)) * bps);
  const toBlock = startHead;
  const fromTs = num((await rpc.call('eth_getBlockByNumber', [hex(fromBlock), false])).timestamp);
  const toTs = num(bHead.timestamp);
  blockTs.set(fromBlock, fromTs); blockTs.set(toBlock, toTs);
  const nonceStart = num(await rpc.call('eth_getTransactionCount', [OUR_SENDER, 'latest']));
  log(`window: blocks ${fromBlock}-${toBlock} (${(toTs - fromTs) / 3600} h, ${bps.toFixed(2)} blocks/s); our sender nonce now ${nonceStart}`);

  // ---- 1. Every swap event in the window -----------------------------------
  const byTxKey = new Map<string, Cand>();
  let chunk = 1500, nb = fromBlock, swaps = 0, lastShow = Date.now();
  while (nb <= toBlock) {
    const to = Math.min(toBlock, nb + chunk - 1);
    let logs: RawLog[];
    try { logs = (await rpc.call('eth_getLogs', [{ fromBlock: hex(nb), toBlock: hex(to), topics: [ALL_SWAP_TOPICS] }])) ?? []; }
    catch (e: any) { if (e?.rangeError && chunk > 20) { chunk = Math.max(20, Math.floor(chunk / 2)); continue; } throw e; }
    byTxKey.clear();
    for (const l of logs) {
      if ((l as any).removed) continue;
      const s = decodeSwapLog(l);
      if (!s) continue;
      const b = num(l.blockNumber), ti = num(l.transactionIndex);
      const pi = poolId(s.pool);
      R.block.push(b); R.ti.push(ti); R.pool.push(pi);
      R.a0.push(s.a0 !== undefined ? Number(s.a0) : NaN); R.a1.push(s.a1 !== undefined ? Number(s.a1) : NaN);
      swaps++;
      const k = `${b}:${ti}`;
      let c = byTxKey.get(k);
      if (!c) { c = { hash: lc(l.transactionHash ?? ''), block: b, ti, pools: [] }; byTxKey.set(k, c); }
      if (!c.pools.includes(pi)) c.pools.push(pi);
    }
    for (const c of byTxKey.values()) if (c.pools.length >= 2) cands.push(c);
    nb = to + 1;
    if (logs.length < 4000) chunk = Math.min(4000, Math.ceil(chunk * 1.3)); else if (logs.length > 8000) chunk = Math.max(20, Math.floor(chunk * 0.6));
    if (Date.now() - lastShow > 60_000) { lastShow = Date.now(); log(`swaps: ${(100 * (nb - fromBlock) / (toBlock - fromBlock + 1)).toFixed(0)}% read, ${swaps} swaps, ${cands.length} multi-pool txs, rps ${rpc.rps.toFixed(1)}`); }
  }
  log(`swap scan done: ${swaps} swaps on ${pools.length} pools, ${cands.length} multi-pool txs, ${rpc.http} http requests`);

  // ---- 2. Which coins / exchange each pool is ------------------------------
  const info = new Map<string, { t0: string; t1: string; dex: string; hooks?: string }>();
  // V4 pool ids: their creation event (whole history, a few ids at a time).
  const v4ids = pools.filter((p) => p.length === 66);
  const balancerLike = new Set<number>();
  for (let i = 0; i < v4ids.length; i += 40) {
    const ids = v4ids.slice(i, i + 40);
    const stack: [number, number][] = [[0, toBlock]];
    let guard = 0;
    while (stack.length && guard++ < 64) {
      const [f, t] = stack.pop()!;
      try {
        const ls: RawLog[] = (await rpc.call('eth_getLogs', [{ address: ROBINHOOD_V4.POOL_MANAGER, fromBlock: hex(f), toBlock: hex(t), topics: [V4_INITIALIZE, ids] }], 90_000)) ?? [];
        for (const l of ls) {
          const id = lc(l.topics[1]);
          const c0 = '0x' + l.topics[2].slice(26).toLowerCase(), c1 = '0x' + l.topics[3].slice(26).toLowerCase();
          const hooks = lc('0x' + (l.data ?? '').slice(2 + 64 * 2 + 24, 2 + 64 * 3));
          info.set(id, { t0: c0, t1: c1, dex: hooks === ZERO_ADDR ? 'uniswap-v4' : 'uniswap-v4-hooked', hooks });
        }
      } catch (e: any) {
        if (t - f < 50_000) continue;
        const mid = Math.floor((f + t) / 2); stack.push([mid + 1, t], [f, mid]);
      }
    }
  }
  log(`V4 pools identified: ${v4ids.filter((x) => info.has(x)).length}/${v4ids.length}`);
  // Address pools: token0 / token1 / factory through Multicall3.
  const SEL = { token0: '0x0dfe1681', token1: '0xd21220a7', factory: '0xc45a0155', decimals: '0x313ce567', symbol: '0x95d89b41' };
  const asAddr = (r: string | null | undefined) => (r && r.length >= 66 ? '0x' + r.slice(26, 66).toLowerCase() : undefined);
  async function multi(calls: { target: string; data: string }[]): Promise<(string | null)[]> {
    const res: (string | null)[] = [];
    const reqs: { method: string; params: unknown[] }[] = [];
    for (let i = 0; i < calls.length; i += 150) reqs.push({ method: 'eth_call', params: [{ to: MULTICALL3, data: encodeAggregate3(calls.slice(i, i + 150)) }, 'latest'] });
    const answers = await rpc.many(reqs, 90_000);
    answers.forEach((a, k) => {
      const n = Math.min(150, calls.length - k * 150);
      let dec: (string | null)[] = [];
      try { dec = a ? decodeAggregate3(a) : []; } catch { dec = []; }
      for (let j = 0; j < n; j++) res.push(dec[j] ?? null);
    });
    return res;
  }
  const addrPools = pools.filter((p) => p.length === 42);
  const pr = await multi(addrPools.flatMap((x) => [{ target: x, data: SEL.token0 }, { target: x, data: SEL.token1 }, { target: x, data: SEL.factory }]));
  addrPools.forEach((x, i) => {
    const t0 = asAddr(pr[3 * i]), t1 = asAddr(pr[3 * i + 1]), f = asAddr(pr[3 * i + 2]);
    if (!t0 || !t1) { balancerLike.add(poolIdx.get(x)!); return; }
    let dex = 'unknown';
    if (f) {
      const k = ROBINHOOD_SCAN_FACTORIES.find((z) => lc(z.factory) === f);
      dex = k ? k.dex : (venueByFactory(f)?.id ?? `factory:${f.slice(0, 10)}`);
    }
    info.set(x, { t0, t1, dex });
  });
  log(`address pools identified: ${addrPools.filter((x) => info.has(x)).length}/${addrPools.length}`);
  // Coins: decimals and symbol.
  const toks = new Set<string>([WETH, USDG]);
  for (const v of info.values()) { toks.add(v.t0); toks.add(v.t1); }
  toks.delete(ZERO_ADDR);
  const tl = [...toks];
  const tr = await multi(tl.flatMap((t) => [{ target: t, data: SEL.decimals }, { target: t, data: SEL.symbol }]));
  const tokens: Record<string, { d: number | null; s: string | null }> = {};
  tl.forEach((t, i) => {
    let d: number | null = null;
    const r = tr[2 * i];
    if (r && r.length >= 66) { try { const v = Number(BigInt(r.slice(0, 66))); d = v <= 36 ? v : null; } catch { /* none */ } }
    const s = fastDecodeString(tr[2 * i + 1]);
    tokens[t] = { d, s: s ? s.replace(/[^\x20-\x7e]/g, '').slice(0, 16) : null };
  });
  tokens[ZERO_ADDR] = { d: 18, s: 'ETH' };
  tokens[WETH] = { d: 18, s: 'WETH' }; tokens[USDG] = { d: tokens[USDG]?.d ?? 6, s: 'USDG' };
  const dec = (t: string): number | null => (t === ZERO_ADDR ? 18 : tokens[t]?.d ?? null);
  const asErc = (t: string) => (t === ZERO_ADDR ? WETH : t);  // plain ETH counts as WETH
  log(`coins: ${tl.length}, decimals known for ${tl.filter((t) => tokens[t].d !== null).length}`);

  // ---- 3. Prices from the swaps themselves ----------------------------------
  const stables = new Set([USDG]);
  const isQuote = (t: string) => stables.has(t) || t === WETH;
  const obs: PriceObs[] = [];
  for (let i = 0; i < R.block.length; i++) {
    const p = pools[R.pool[i]];
    const inf = info.get(p);
    if (!inf || !isFinite(R.a0[i]) || !isFinite(R.a1[i])) continue;
    const t0 = asErc(inf.t0), t1 = asErc(inf.t1);
    if (!isQuote(t0) && !isQuote(t1)) continue;
    const d0 = dec(t0), d1 = dec(t1);
    if (d0 === null || d1 === null) continue;
    let a0: bigint, a1: bigint;
    try { a0 = BigInt(Math.round(R.a0[i])); a1 = BigInt(Math.round(R.a1[i])); } catch { continue; }
    for (const o of obsFromSwap(R.block[i], p, t0, t1, a0, a1, d0, d1, isQuote)) obs.push(o);
  }
  const book = buildPriceBook(obs, stables, WETH);
  const midBlock = Math.floor((fromBlock + toBlock) / 2);
  log(`price observations: ${obs.length}; ETH at mid-window $${book.ethAt(midBlock)?.toFixed(0)}`);

  // ---- 4. Which multi-pool transactions to read ----------------------------
  // Tier 1: every pool on an exchange our bot can trade and some pair seen
  // twice (a 2-pool round trip shape) - read ALL. Tier 2: everything else,
  // a random sample as time allows (coverage is recorded for scaling).
  const pairOfIdx = (pi: number): string | null => {
    const inf = info.get(pools[pi]); if (!inf) return null;
    return [asErc(inf.t0), asErc(inf.t1)].sort().join('/');
  };
  const tradeableIdx = (pi: number) => { const inf = info.get(pools[pi]); return !!inf && TRADEABLE.has(inf.dex); };
  const tier = (c: Cand): 1 | 2 => {
    if (!c.pools.every(tradeableIdx)) return 2;
    const ps = c.pools.map(pairOfIdx);
    const touchesBase = c.pools.some((pi) => { const inf = info.get(pools[pi])!; return [asErc(inf.t0), asErc(inf.t1)].some((t) => t === WETH || t === USDG); });
    return touchesBase && (new Set(ps).size < ps.length || c.pools.length >= 3) ? 1 : 2;
  };
  // Deterministic shuffle (same order on every run of the same data).
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const t1 = cands.filter((c) => tier(c) === 1), t2 = cands.filter((c) => tier(c) === 2);
  for (const arr of [t1, t2]) for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  log(`multi-pool txs: tier 1 (our-bot shape) ${t1.length}, tier 2 (rest) ${t2.length}`);

  // ---- 5. Receipts and the arbitrage check ---------------------------------
  const v4Currencies = (id: string) => { const i = info.get(id); return i ? { c0: i.t0, c1: i.t1 } : null; };
  const arbsFile = `${OUT}/arbs.jsonl`;
  writeFileSync(arbsFile, '');
  const reasons: Record<string, Record<string, number>> = { '1': {}, '2': {} };
  const readCount = { '1': 0, '2': 0 };
  const isArbKey = new Set<string>();        // block:ti of arbitrage txs
  const readKey = new Set<string>();         // block:ti of read txs
  const nonArbTo = new Map<string, string>(); // block:ti -> tx.to of read non-arbitrage txs
  const arbs: (ArbRecord & { tier: number })[] = [];
  const deadline = Date.now() + RECEIPT_MIN * 60_000;
  const step = BATCH * 3;
  let lastSave = Date.now();
  // Interleaved queue: two batches of tier 1 for every batch of tier 2, so
  // both get read even if time runs out (tier 1 is smaller and goes first).
  const queue: [string, Cand[]][] = [];
  for (let i1 = 0, i2 = 0; i1 < t1.length || i2 < t2.length;) {
    for (let k = 0; k < 2 && i1 < t1.length; k++, i1 += step) queue.push(['1', t1.slice(i1, i1 + step)]);
    if (i2 < t2.length) { queue.push(['2', t2.slice(i2, i2 + step)]); i2 += step; }
  }
  let qi = 0;
  {
    for (; qi < queue.length && Date.now() < deadline; qi++) {
      const [tn, part] = queue[qi];
      // Three batches in flight at once.
      const groups: Cand[][] = [];
      for (let k = 0; k < part.length; k += BATCH) groups.push(part.slice(k, k + BATCH));
      const res = await Promise.all(groups.map((g) => rpc.many(g.map((c) => ({ method: 'eth_getTransactionReceipt', params: [c.hash] })))));
      groups.forEach((g, gi) => g.forEach((c, ci) => {
        const r = res[gi][ci];
        const key = `${c.block}:${c.ti}`;
        if (!r || !r.logs) { reasons[tn]['no-receipt'] = (reasons[tn]['no-receipt'] ?? 0) + 1; return; }
        readCount[tn]++; readKey.add(key);
        const gas = receiptGasWei(r);
        const out = classifyTx(r.logs, r.from, r.to, r.status, { hash: c.hash, block: c.block, txIndex: c.ti, ...gas }, { poolManager: PM, weth: WETH, v4Currencies });
        reasons[tn][out.reason] = (reasons[tn][out.reason] ?? 0) + 1;
        if (out.arb) { const a = { ...out.arb, tier: Number(tn) }; arbs.push(a); isArbKey.add(key); appendFileSync(arbsFile, JSON.stringify(a) + '\n'); }
        else nonArbTo.set(key, lc(r.to ?? ''));
      }));
      if (Date.now() - lastSave > 60_000) { lastSave = Date.now(); log(`receipts: tier1 ${readCount['1']}/${t1.length}, tier2 ${readCount['2']}/${t2.length}, arbitrage so far ${arbs.length}, rps ${rpc.rps.toFixed(1)}, 429s ${rpc.limited}`); }
    }
  }
  log(`receipts done: tier1 ${readCount['1']}/${t1.length}, tier2 ${readCount['2']}/${t2.length}, arbitrage ${arbs.length}`);

  // ---- 6. Timing: the trade each arbitrage followed --------------------------
  // Per pool, its swap rows in order (block, ti). The "opening trade" is the
  // latest earlier swap on any of the arbitrage's pools by a transaction that
  // is NOT itself an arbitrage (unread transactions count as trades).
  const rowsByPool = new Map<number, number[]>();
  for (let i = 0; i < R.block.length; i++) { const p = R.pool[i]; (rowsByPool.get(p) ?? rowsByPool.set(p, []).get(p)!).push(i); }
  const timing = new Map<string, any>();
  for (const a of arbs) {
    let best: { b: number; ti: number } | null = null;
    let prevArb: { b: number; ti: number } | null = null;
    for (const p of a.pools) {
      const pi = poolIdx.get(p); if (pi === undefined) continue;
      const rows = rowsByPool.get(pi) ?? [];
      // binary search for the first row at/after (a.block, a.txIndex)
      let lo = 0, hi = rows.length;
      while (lo < hi) { const m = (lo + hi) >> 1; const r = rows[m]; if (R.block[r] < a.block || (R.block[r] === a.block && R.ti[r] < a.txIndex)) lo = m + 1; else hi = m; }
      for (let j = lo - 1, seen = 0; j >= 0 && seen < 200; j--, seen++) {
        const r = rows[j]; const key = `${R.block[r]}:${R.ti[r]}`;
        if (R.block[r] < a.block - 2_000) break;
        if (isArbKey.has(key)) { if (!prevArb || R.block[r] > prevArb.b || (R.block[r] === prevArb.b && R.ti[r] > prevArb.ti)) prevArb = { b: R.block[r], ti: R.ti[r] }; continue; }
        if (!best || R.block[r] > best.b || (R.block[r] === best.b && R.ti[r] > best.ti)) best = { b: R.block[r], ti: R.ti[r] };
        break;
      }
    }
    timing.set(a.hash, best ? {
      trigBlock: best.b, trigTi: best.ti, dBlocks: a.block - best.b, trigTo: nonArbTo.get(`${best.b}:${best.ti}`) ?? null,
      trigRead: readKey.has(`${best.b}:${best.ti}`),
      arbBetween: !!prevArb && (prevArb.b > best.b || (prevArb.b === best.b && prevArb.ti > best.ti)),
    } : { trigBlock: null });
  }

  // ---- 7. Census: every receipt of a recent stretch of blocks ----------------
  // Blocks from the window's end forward (the time this job has been running),
  // all transactions incl. failed ones. Also confirms our nonce count.
  const censusEndHead = num(await rpc.call('eth_blockNumber', []));
  const nonceEnd = num(await rpc.call('eth_getTransactionCount', [OUR_SENDER, 'latest']));
  const cDeadline = Date.now() + CENSUS_MIN * 60_000;
  const census = { fromBlock: toBlock + 1, toBlock: toBlock, blocks: 0, txs: 0, failed: 0, byTo: {} as Record<string, { n: number; ok: number; fail: number; arb: number; gasWei: string; senders: Record<string, number> }>, ourTxs: [] as any[], censusArbs: [] as any[] };
  const byToGas = new Map<string, bigint>();
  let cb = toBlock + 1, stalls = 0;
  while (cb <= censusEndHead && Date.now() < cDeadline) {
    const blocksAsk: number[] = [];
    for (let k = 0; k < BATCH * 3 && cb + k <= censusEndHead; k++) blocksAsk.push(cb + k);
    const groups: number[][] = [];
    for (let k = 0; k < blocksAsk.length; k += BATCH) groups.push(blocksAsk.slice(k, k + BATCH));
    const res = await Promise.all(groups.map((g) => rpc.many(g.map((b) => ({ method: 'eth_getBlockReceipts', params: [hex(b)] })), 90_000)));
    let stop = false;
    groups.forEach((g, gi) => g.forEach((b, bi) => {
      const list = res[gi][bi];
      if (!Array.isArray(list)) { stop = true; return; }
      if (stop) return;
      census.blocks++; census.toBlock = Math.max(census.toBlock, b);
      for (const r of list) {
        const to = lc(r.to ?? ''); const from = lc(r.from ?? '');
        if (!to || r.type === '0x6a' || r.type === '0x6b' || r.type === '0x64' || r.type === '0x65' || r.type === '0x66' || r.type === '0x68' || r.type === '0x69') continue; // Arbitrum system txs
        census.txs++;
        const ok = r.status === '0x1';
        if (!ok) census.failed++;
        const e = census.byTo[to] ?? (census.byTo[to] = { n: 0, ok: 0, fail: 0, arb: 0, gasWei: '0', senders: {} });
        e.n++; if (ok) e.ok++; else e.fail++;
        e.senders[from] = (e.senders[from] ?? 0) + 1;
        const gas = receiptGasWei(r);
        byToGas.set(to, (byToGas.get(to) ?? 0n) + gas.gasWei);
        let arb: ArbRecord | null = null;
        if (ok && r.logs?.length >= 2) {
          const out = classifyTx(r.logs, r.from, r.to, r.status, { hash: lc(r.transactionHash), block: b, txIndex: num(r.transactionIndex), ...gas }, { poolManager: PM, weth: WETH, v4Currencies });
          if (out.arb) { arb = out.arb; e.arb++; census.censusArbs.push(out.arb); }
        }
        if (from === OUR_SENDER || to === OUR_EXEC) census.ourTxs.push({ hash: lc(r.transactionHash), block: b, ti: num(r.transactionIndex), ok, gasWei: gas.gasWei.toString(), arb: !!arb, logs: r.logs?.length ?? 0, net: arb?.net ?? null });
      }
    }));
    if (stop && ++stalls < 5) { await sleep(2_000); }
    else { cb += blocksAsk.length; stalls = 0; }
    if (Date.now() - lastSave > 60_000) { lastSave = Date.now(); log(`census: ${census.blocks} blocks (${cb}/${censusEndHead}), ${census.txs} txs, failed ${census.failed}, our txs ${census.ourTxs.length}, rps ${rpc.rps.toFixed(1)}`); }
  }
  for (const [to, g] of byToGas) if (census.byTo[to]) census.byTo[to].gasWei = g.toString();
  // Keep only addresses that matter (bots: any arbitrage or 20+ txs).
  const keep: typeof census.byTo = {};
  for (const [to, e] of Object.entries(census.byTo)) if (e.arb > 0 || e.n >= 20 || to === OUR_EXEC) { const s = Object.entries(e.senders).sort((x, y) => y[1] - x[1]); keep[to] = { ...e, senders: Object.fromEntries(s.slice(0, 10)) }; (keep[to] as any).senderCount = s.length; }
  census.byTo = keep;
  const censusTs = { from: census.blocks ? num((await rpc.call('eth_getBlockByNumber', [hex(census.fromBlock), false])).timestamp) : null, to: census.blocks ? num((await rpc.call('eth_getBlockByNumber', [hex(census.toBlock), false])).timestamp) : null };
  log(`census done: blocks ${census.fromBlock}-${census.toBlock} (${census.blocks}), txs ${census.txs}, our txs ${census.ourTxs.length}; our nonce went ${nonceStart} -> ${nonceEnd} by block ${censusEndHead}`);

  // ---- 8. Save everything for the report step -------------------------------
  // Pool info and coin info only for pools/coins that appear in arbitrage.
  const usedPools = new Set<string>();
  for (const a of arbs) for (const p of a.pools) usedPools.add(p);
  for (const a of census.censusArbs) for (const p of a.pools) usedPools.add(p);
  const poolOut: Record<string, any> = {};
  for (const p of usedPools) { const i = info.get(p); poolOut[p] = i ? { ...i, pair: [tokens[asErc(i.t0)]?.s ?? i.t0.slice(0, 8), tokens[asErc(i.t1)]?.s ?? i.t1.slice(0, 8)].join('/') } : null; }
  // USD prices for every coin in arbitrage at its block (so the report needs no book).
  const priceAt = (t: string, b: number) => { const p = book.usdAt(asErc(t), b); return p ? { usd: p.usd, vol: p.volumeUsd } : null; };
  const priced = (a: ArbRecord) => ({
    hash: a.hash,
    net: a.net.map(([t]) => [t, priceAt(t, a.block)]),
    out: a.outflow.map(([t]) => [t, priceAt(t, a.block)]),
    hop0: a.hops[0]?.tin ? priceAt(a.hops[0].tin, a.block) : null,
    eth: book.ethAt(a.block),
  });
  writeFileSync(`${OUT}/arb-prices.jsonl`, [...arbs, ...census.censusArbs].map((a) => JSON.stringify(priced(a))).join('\n') + '\n');
  writeFileSync(`${OUT}/timing.json`, JSON.stringify(Object.fromEntries(timing)));
  // Swap activity per pool for pools in arbitrage (how busy they are).
  const poolSwaps: Record<string, number> = {};
  for (const p of usedPools) { const pi = poolIdx.get(p); if (pi !== undefined) poolSwaps[p] = rowsByPool.get(pi)?.length ?? 0; }
  // Our-bot shape pools (tradeable, pair on 2+ tradeable exchanges).
  const pairDexes = new Map<string, Set<string>>();
  for (const [p, i] of info) if (TRADEABLE.has(i.dex)) { const k = [asErc(i.t0), asErc(i.t1)].sort().join('/'); (pairDexes.get(k) ?? pairDexes.set(k, new Set()).get(k)!).add(i.dex); void p; }
  const ourShapePools: string[] = [];
  for (const [p, i] of info) if (TRADEABLE.has(i.dex)) { const k = [asErc(i.t0), asErc(i.t1)].sort().join('/'); if ((pairDexes.get(k)?.size ?? 0) >= 2 && (k.includes(WETH) || k.includes(USDG))) ourShapePools.push(p); }
  const tokOut: Record<string, any> = {};
  const usedToks = new Set<string>();
  for (const a of [...arbs, ...census.censusArbs]) { for (const [t] of a.net) usedToks.add(t); for (const [t] of a.outflow) usedToks.add(t); for (const h of a.hops) { if (h.tin) usedToks.add(h.tin); if (h.tout) usedToks.add(h.tout); } }
  for (const t of usedToks) tokOut[t] = tokens[t] ?? null;
  writeFileSync(`${OUT}/census.json`, JSON.stringify({ ...census, censusTs }, null, 0));
  writeFileSync(`${OUT}/meta.json`, JSON.stringify({
    window: { fromBlock, toBlock, fromTs, toTs, hours: (toTs - fromTs) / 3600, blocksPerSec: bps },
    swaps, pools: pools.length, poolsIdentified: info.size, multiPoolTxs: cands.length,
    tier1: { total: t1.length, read: readCount['1'], reasons: reasons['1'] },
    tier2: { total: t2.length, read: readCount['2'], reasons: reasons['2'] },
    arbs: arbs.length, ethMid: book.ethAt(midBlock),
    ourSender: { nonceStart, nonceEnd, nonceEndBlock: censusEndHead },
    rpc: { http: rpc.http, calls: rpc.calls, limited: rpc.limited, finalRps: rpc.rps },
    tradeable: [...TRADEABLE], ourShapePools: ourShapePools.length,
    poolInfo: poolOut, tokens: tokOut, poolSwaps,
    ourShapePoolList: ourShapePools,
    minutes: (Date.now() - T0) / 60000,
  }));
  log(`saved results to ${OUT}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[pm] stopped:', String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<node>')); process.exit(1); });
