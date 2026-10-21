// ============================================================================
// MEASURE: the trades that CREATED real opportunities -- can we read them?
// (design 2b, read only)
//
// Plain English:
//   An arbitrage that lands right after someone's trade is the best sign that
//   the trade opened a real money-making gap. So, for a block range:
//     1. find every arbitrage on the pools we trade (the bot's own arbitrage
//        detector, core/followMoney.ts classifyTx)
//     2. for each one, find the trade it followed: the latest NON-arbitrage
//        trade, at most 4 blocks (~1 s) earlier, that swapped on one of the
//        arbitrage's pools = the "opportunity trade"
//     3. ask: can the bot read EXACTLY how that opportunity trade moved our
//        pools, from the trade's own data (what the live feed shows before
//        it lands)? Same two tests as measureTrigger.ts:
//          A. the bot's current decoder reads it exactly
//          B. a better reader could (every swap on our pools has its amount
//             written in the data, or follows straight on from one that does)
//   Also reports who sent the opportunity trades (known routers vs unknown
//   contracts), and how many arbitrages were our own bot's.
//   Writes <out>/opp.json + per-arbitrage lines, prints a summary.
//
// Safety: reads only. From the bot's .env only the --node URL line is read
// (never printed). Sends nothing, signs nothing.
//
// Run (after `npx tsc -p scripts/sim-compare/tsconfig.json`):
//   node .scripts-build/scripts/sim-compare/measureOpp.js --from N --to M
//        [--out DIR] [--rps 5] [--node CHAINSTACK_RPC_ROBINHOOD]
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY } from '../../src/core/decoder';
import { seedKnownAddresses, ROBINHOOD_TOKENS } from '../../src/config/knownAddresses';
import { decodeSwapLog, classifyTx } from '../../src/core/followMoney';

process.env.FEED_DECODE_UR_V4 = process.env.FEED_DECODE_UR_V4 ?? '1'; // bot default (config/envDefaults.ts)

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const FROM = Number(arg('from')), TO = Number(arg('to'));
const OUT = arg('out', `${process.env.HOME}/sim-compare-runs/opp1`)!;
const RPS = Number(arg('rps', '5'));
const NODE_VAR = arg('node', 'CHAINSTACK_RPC_ROBINHOOD')!;
const LOOKBACK_BLOCKS = 4;   // an "opportunity trade" must be at most this many blocks before the arbitrage
const HISTORY_BLOCKS = 40;   // how far back we fetch, to see when the pools last changed
const OUR_BOT = '0x09b4fb908ff646afa9c9878c082add7e4b3784d6'; // bot wallet (Go_Live record)
const OUR_CONTRACT = '0x7e0f847dd429e7c15ab08686d28710389c1f7837';
if (!Number.isFinite(FROM) || !Number.isFinite(TO) || TO < FROM) { console.error('need --from and --to'); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const lc = (s: string) => String(s).toLowerCase();

function nodeUrl(): string {
  if (process.env[NODE_VAR]) return process.env[NODE_VAR]!;
  const m = readFileSync(join(BOT_DIR, '.env'), 'utf8').match(new RegExp(`^\\s*${NODE_VAR}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
  if (!m) throw new Error(`${NODE_VAR} not found in .env`);
  return m[1];
}
const NODE = nodeUrl();
let rid = 0, last = 0, requests = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let a = 0; a < 3; a++) {
    const w = last + 1000 / RPS - Date.now(); if (w > 0) await sleep(w);
    last = Date.now(); requests++;
    try {
      const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }), signal: AbortSignal.timeout(20_000) });
      const j: any = await r.json();
      if (j.error && /limit|busy|429|timeout/i.test(j.error.message || '')) { await sleep(2000); continue; }
      return j;
    } catch { await sleep(1000); }
  }
  return { error: { message: 'gave up' } };
}

// --- pools we trade (pairs on 2+ exchanges), as in measureTrigger.ts -------
type P = { t0: string; t1: string; raw: any };
const WETH = lc(ROBINHOOD_TOKENS.WETH);
const watch = JSON.parse(readFileSync(join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'));
const all: any[] = (watch.pools || []).filter((p: any) => p && p.chain === 'robinhood' && p.poolAddress && p.tokenA && p.tokenB);
const byPair = new Map<string, any[]>();
for (const p of all) { const k = [lc(p.tokenA), lc(p.tokenB)].sort().join('/'); (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p); }
const ours = new Map<string, P>();
for (const list of byPair.values()) {
  if (new Set(list.map((p) => p.dex)).size < 2) continue;
  for (const p of list) { const [t0, t1] = [lc(p.tokenA), lc(p.tokenB)].sort(); ours.set(lc(p.poolAddress), { t0, t1, raw: p }); }
}
const RH_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
// V4 pools: tokenA is currency0 (WETH stands in for plain ETH when native).
const v4Currencies = (id: string) => {
  const p = ours.get(lc(id))?.raw; if (!p) return null;
  const n = (t: string) => (p.v4?.native && lc(t) === WETH ? '0x0000000000000000000000000000000000000000' : lc(t));
  return { c0: n(p.tokenA), c1: n(p.tokenB) };
};

const registry = structuredClone(DEFAULT_ROUTER_REGISTRY);
seedKnownAddresses(registry);
const decoder = new TransactionDecoder(registry, undefined, (_c, addr) => ours.get(lc(addr))?.raw);
const sides = (s: { a0?: bigint; a1?: bigint }, p: P) => (s.a0 === undefined || s.a1 === undefined ? null
  : s.a0 > 0n ? { tin: p.t0, ain: s.a0, tout: p.t1, aout: -s.a1 } : { tin: p.t1, ain: s.a1, tout: p.t0, aout: -s.a0 });
const word = (x: bigint) => (x < 0n ? -x : x).toString(16).padStart(64, '0');

type T = { hash: string; block: number; index: number; from: string; to: string; input: string; value: string; logs: any[]; swaps: any[]; arb: any };

async function main() {
  console.log(`pools we trade: ${ours.size}; blocks ${FROM - HISTORY_BLOCKS}-${TO}`);
  // 1. Every transaction that swapped on our pools (with a little look-back).
  const addrs = [...ours.keys()].filter((a) => a.length === 42), ids = [...ours.keys()].filter((a) => a.length === 66);
  const hashes = new Set<string>();
  for (let b = FROM - HISTORY_BLOCKS; b <= TO; b += 250) {
    const range = { fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(TO, b + 249).toString(16) };
    for (let i = 0; i < addrs.length; i += 200) for (const l of (await rpc('eth_getLogs', [{ ...range, address: addrs.slice(i, i + 200) }])).result ?? []) if (decodeSwapLog(l)) hashes.add(lc(l.transactionHash));
    for (let i = 0; i < ids.length; i += 100) for (const l of (await rpc('eth_getLogs', [{ ...range, address: RH_POOL_MANAGER, topics: [null, ids.slice(i, i + 100)] }])).result ?? []) if (decodeSwapLog(l)) hashes.add(lc(l.transactionHash));
  }
  console.log(`transactions: ${hashes.size}`);

  // 2. Receipts + tx data, classified (arbitrage or not).
  const txs: T[] = [];
  for (const hash of hashes) {
    const [tx, rc] = [await rpc('eth_getTransactionByHash', [hash]), await rpc('eth_getTransactionReceipt', [hash])];
    if (!tx.result || !rc.result || rc.result.status !== '0x1') continue;
    const block = parseInt(rc.result.blockNumber, 16), index = parseInt(rc.result.transactionIndex, 16);
    const logs = rc.result.logs as any[];
    const swaps = logs.map((l) => decodeSwapLog(l)).filter(Boolean) as any[];
    const c = classifyTx(logs, tx.result.from, tx.result.to, rc.result.status, { hash, block, txIndex: index, gasWei: 0n }, { weth: WETH, poolManager: RH_POOL_MANAGER, v4Currencies });
    txs.push({ hash, block, index, from: lc(tx.result.from), to: lc(tx.result.to ?? ''), input: lc(tx.result.input ?? '0x'), value: tx.result.value, logs, swaps, arb: c.arb });
    if (txs.length % 200 === 0) console.log(`${txs.length}/${hashes.size} fetched · node requests ${requests}`);
  }
  txs.sort((a, b) => a.block - b.block || a.index - b.index);

  // 3. Each arbitrage in range -> the opportunity trade it followed.
  const readable = async (t: T) => {
    let A = false;
    try {
      const d = await decoder.decode({ chain: 'robinhood', stateType: 'pending' as any, blockOrSeq: 0, receivedAtMs: Date.now(), raw: { to: t.to, data: t.input, value: t.value } });
      if (d) A = t.swaps.some((s) => { const p = ours.get(s.pool); const sd = p && sides(s, p); return !!sd && sd.tin === lc(d.tokenIn) && sd.tout === lc(d.tokenOut) && sd.ain === d.amountIn; });
    } catch { /* refused */ }
    let prev: { tout: string; aout: bigint } | null = null, B = true, any = false;
    for (const s of t.swaps) {
      const p = ours.get(s.pool); const sd = p ? sides(s, p) : null;
      if (!p || !sd) { prev = null; continue; }
      any = true;
      const ok = t.input.includes(word(sd.ain)) || t.input.includes(word(sd.aout)) || (!!prev && prev.tout === sd.tin && prev.aout === sd.ain);
      if (ok) prev = { tout: sd.tout, aout: sd.aout }; else { B = false; prev = null; }
    }
    return { A, B: A || (B && any) };
  };
  const rows: any[] = [];
  const c = { arbs: 0, ourBotArbs: 0, withTrigger: 0, noTrigger_followedAnotherArbOrStanding: 0, trigA: 0, trigB: 0, trigToKnownRouter: 0, trigSingleSwap: 0, trigSameBlock: 0 };
  const senders = new Map<string, { n: number; B: number; known: boolean }>();
  const reaction = new Map<string, number>(); // arbitrages by blocks since the last change on their pools
  for (let i = 0; i < txs.length; i++) {
    const a = txs[i];
    if (!a.arb || a.block < FROM || !a.swaps.some((s) => ours.has(s.pool))) continue;
    c.arbs++;
    if (a.from === OUR_BOT || a.to === OUR_CONTRACT) c.ourBotArbs++;
    const pools = new Set(a.swaps.map((s) => s.pool));
    // How long the gap sat: blocks since the last transaction (of any kind)
    // that touched these pools before this arbitrage (same block = 0).
    let lastChange: number | null = null;
    for (let j = i - 1; j >= 0; j--) { const t = txs[j]; if (t.swaps.some((s) => pools.has(s.pool))) { lastChange = a.block - t.block; break; } }
    const bucket = lastChange === null ? 'none seen' : lastChange === 0 ? 'same block' : lastChange === 1 ? '1 block' : lastChange <= 4 ? '2-4 blocks' : lastChange <= 40 ? '5-40 blocks (1-10 s)' : '>40 blocks';
    reaction.set(bucket, (reaction.get(bucket) ?? 0) + 1);
    let trig: T | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const t = txs[j];
      if (t.block < a.block - LOOKBACK_BLOCKS) break;
      if (!t.swaps.some((s) => pools.has(s.pool))) continue;
      if (t.arb) break; // the last thing on these pools was another arbitrage: no fresh gap from a trade
      trig = t; break;
    }
    if (!trig) { c.noTrigger_followedAnotherArbOrStanding++; rows.push({ arb: a.hash, trigger: null }); continue; }
    c.withTrigger++;
    const r = await readable(trig);
    if (r.A) c.trigA++;
    if (r.B) c.trigB++;
    const known = !!registry.robinhood[trig.to];
    if (known) c.trigToKnownRouter++;
    if (trig.swaps.length === 1) c.trigSingleSwap++;
    if (trig.block === a.block) c.trigSameBlock++;
    const s = senders.get(trig.to) ?? { n: 0, B: 0, known }; s.n++; if (r.B) s.B++; senders.set(trig.to, s);
    rows.push({ arb: a.hash, arbBy: a.to, trigger: trig.hash, trigTo: trig.to, knownRouter: known, gapBlocks: a.block - trig.block, A: r.A, B: r.B });
  }
  const pct = (n: number) => (c.withTrigger ? +(100 * n / c.withTrigger).toFixed(1) : 0);
  const summary = {
    blocks: TO - FROM + 1, ...c,
    pct_trig_readableToday_A: pct(c.trigA), pct_trig_readableBetterReader_B: pct(c.trigB),
    pct_trig_toKnownRouter: pct(c.trigToKnownRouter), pct_trig_singleSwap: pct(c.trigSingleSwap), pct_trig_sameBlockAsArb: pct(c.trigSameBlock),
    arbsByBlocksSinceLastPoolChange: Object.fromEntries(reaction),
    topTriggerSenders: [...senders.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 12).map(([to, v]) => ({ to, ...v })),
    nodeRequestsUsed: requests,
  };
  writeFileSync(join(OUT, 'opp.json'), JSON.stringify(summary, null, 1));
  writeFileSync(join(OUT, 'per-arb.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log('SUMMARY ' + JSON.stringify(summary));
}
main().catch((e) => { console.error('ERROR', e?.message ?? e); process.exit(1); });
