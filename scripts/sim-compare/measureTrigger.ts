// ============================================================================
// MEASURE (design 2b): can we tell EXACTLY how a trigger moves our pools,
// just from the trigger's own data (no node lookups)?  Read only.
//
// Plain English:
//   For every transaction in a block range that swapped on one of the pools
//   we trade (pairs on 2+ exchanges, from the bot's watch list), compare
//   what the transaction's own data says (what the bot sees in the live
//   feed, before the trade lands) with what really happened to our pools
//   (the pools' swap reports in the receipt). Per transaction it asks:
//     A. Does the bot's CURRENT decoder already read it exactly?
//        (same coin in, same amount, on a pool of the right pair)
//     B. Could a better reader get it exactly? Every swap on our pools is
//        "knowable" if its input or output amount is written in the
//        transaction's data, or it directly follows a knowable swap on one
//        of our pools in the same route (amount handed straight on).
//     C. Not knowable from the data (amount depends on something else, e.g.
//        a pool we don't copy, or "use the whole balance").
//   Writes <out>/trigger.json (+ per-tx lines) and prints a summary.
//
// Safety: reads only. From the bot's .env only the --node URL line is read
// (never printed). Sends nothing, signs nothing.
//
// Run (after `npx tsc -p scripts/sim-compare/tsconfig.json`):
//   node .scripts-build/scripts/sim-compare/measureTrigger.js --from N --to M
//        [--out DIR] [--rps 5] [--node CHAINSTACK_RPC_ROBINHOOD]
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY } from '../../src/core/decoder';
import { seedKnownAddresses } from '../../src/config/knownAddresses';
import { decodeSwapLog } from '../../src/core/followMoney';

process.env.FEED_DECODE_UR_V4 = process.env.FEED_DECODE_UR_V4 ?? '1'; // same as the bot's default (config/envDefaults.ts)

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const FROM = Number(arg('from')), TO = Number(arg('to'));
const OUT = arg('out', `${process.env.HOME}/sim-compare-runs/trigger1`)!;
const RPS = Number(arg('rps', '5'));
const NODE_VAR = arg('node', 'CHAINSTACK_RPC_ROBINHOOD')!;
if (!Number.isFinite(FROM) || !Number.isFinite(TO) || TO < FROM) { console.error('need --from and --to'); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const lc = (s: string) => String(s).toLowerCase();

// --- node access: only the one .env line asked for, never printed ----------
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

// --- the pools we trade: pairs with pools on 2+ exchanges ------------------
type P = { addr: string; dex: string; t0: string; t1: string; isV4: boolean; raw: any };
const watch = JSON.parse(readFileSync(join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'));
const all: any[] = (watch.pools || []).filter((p: any) => p && p.chain === 'robinhood' && p.poolAddress && p.tokenA && p.tokenB);
const byPair = new Map<string, any[]>();
for (const p of all) { const k = [lc(p.tokenA), lc(p.tokenB)].sort().join('/'); (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p); }
const ours = new Map<string, P>(); // pool address or V4 id -> pool
for (const list of byPair.values()) {
  if (new Set(list.map((p) => p.dex)).size < 2) continue;
  for (const p of list) {
    const [t0, t1] = [lc(p.tokenA), lc(p.tokenB)].sort();
    ours.set(lc(p.poolAddress), { addr: lc(p.poolAddress), dex: p.dex, t0, t1, isV4: lc(p.poolAddress).length === 66, raw: p });
  }
}
const RH_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

// --- the bot's own decoder, set up like shadowMain does --------------------
const registry = structuredClone(DEFAULT_ROUTER_REGISTRY);
seedKnownAddresses(registry);
const decoder = new TransactionDecoder(registry, undefined, (_c, addr) => ours.get(lc(addr))?.raw);

// Pool-side amounts of one swap report: what went IN and what came OUT.
function sides(s: { a0?: bigint; a1?: bigint }, p: P) {
  if (s.a0 === undefined || s.a1 === undefined) return null;
  return s.a0 > 0n ? { tin: p.t0, ain: s.a0, tout: p.t1, aout: -s.a1 } : { tin: p.t1, ain: s.a1, tout: p.t0, aout: -s.a0 };
}
const word = (x: bigint) => (x < 0n ? -x : x).toString(16).padStart(64, '0');

async function main() {
  console.log(`pools we trade: ${ours.size} (pairs on 2+ exchanges); blocks ${FROM}-${TO}`);
  // 1. Which transactions swapped on our pools (pool reports in the range).
  const addrs = [...ours.keys()].filter((a) => a.length === 42);
  const ids = [...ours.keys()].filter((a) => a.length === 66);
  const txs = new Set<string>();
  for (let b = FROM; b <= TO; b += 250) {
    const range = { fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(TO, b + 249).toString(16) };
    for (let i = 0; i < addrs.length; i += 200) for (const l of (await rpc('eth_getLogs', [{ ...range, address: addrs.slice(i, i + 200) }])).result ?? []) if (decodeSwapLog(l)) txs.add(lc(l.transactionHash));
    for (let i = 0; i < ids.length; i += 100) for (const l of (await rpc('eth_getLogs', [{ ...range, address: RH_POOL_MANAGER, topics: [null, ids.slice(i, i + 100)] }])).result ?? []) if (decodeSwapLog(l)) txs.add(lc(l.transactionHash));
  }
  console.log(`transactions that swapped on our pools: ${txs.size}`);

  // 2. Per transaction: data vs reality.
  const rows: any[] = [];
  const count = { total: 0, A_decoderExact: 0, B_knowable: 0, C_notKnowable: 0, singleSwap: 0, allSwapsOnOurPools: 0, toKnownRouter: 0, failedTx: 0 };
  const byTo = new Map<string, { n: number; A: number; B: number }>();
  for (const hash of txs) {
    const [tx, rc] = [await rpc('eth_getTransactionByHash', [hash]), await rpc('eth_getTransactionReceipt', [hash])];
    if (!tx.result || !rc.result) continue;
    if (rc.result.status !== '0x1') { count.failedTx++; continue; }
    const to = lc(tx.result.to ?? ''), input = lc(tx.result.input ?? '0x');
    const swaps = (rc.result.logs as any[]).map((l) => ({ l, s: decodeSwapLog(l) })).filter((x) => x.s) as { l: any; s: any }[];
    const ourSwaps = swaps.filter((x) => ours.has(x.s.pool));
    if (!ourSwaps.length) continue;
    count.total++;
    if (swaps.length === 1) count.singleSwap++;
    if (swaps.every((x) => ours.has(x.s.pool))) count.allSwapsOnOurPools++;
    const knownRouter = !!registry.robinhood[to];
    if (knownRouter) count.toKnownRouter++;

    // A: the bot's decoder today.
    let A = false;
    try {
      const d = await decoder.decode({ chain: 'robinhood', stateType: 'pending' as any, blockOrSeq: 0, receivedAtMs: Date.now(), raw: { to, data: input, value: tx.result.value } });
      if (d) A = ourSwaps.some((x) => { const sd = sides(x.s, ours.get(x.s.pool)!); return !!sd && sd.tin === lc(d.tokenIn) && sd.tout === lc(d.tokenOut) && sd.ain === d.amountIn; });
    } catch { /* decoder refused */ }

    // B: every swap on our pools reachable from amounts written in the data,
    // or handed straight on from the previous swap (on one of our pools).
    let prevKnown: { tout: string; aout: bigint } | null = null;
    let B = true;
    for (const x of swaps) {
      const p = ours.get(x.s.pool);
      const sd = p ? sides(x.s, p) : null;
      if (!p || !sd) { prevKnown = null; continue; } // a pool we don't copy: the chain of known amounts breaks
      const inData = input.includes(word(sd.ain)) || input.includes(word(sd.aout));
      const handedOn = !!prevKnown && prevKnown.tout === sd.tin && prevKnown.aout === sd.ain;
      if (inData || handedOn) prevKnown = { tout: sd.tout, aout: sd.aout };
      else { B = false; prevKnown = null; }
    }
    if (A) count.A_decoderExact++;
    if (A || B) count.B_knowable++; else count.C_notKnowable++;
    const t = byTo.get(to) ?? { n: 0, A: 0, B: 0 }; t.n++; if (A) t.A++; if (A || B) t.B++; byTo.set(to, t);
    rows.push({ hash, to, knownRouter, swaps: swaps.length, ourSwaps: ourSwaps.length, A, B: A || B });
    if (count.total % 100 === 0) console.log(`${count.total} checked · node requests ${requests}`);
  }

  const pct = (n: number) => (count.total ? +(100 * n / count.total).toFixed(1) : 0);
  const summary = {
    blocks: TO - FROM + 1, poolsWeTrade: ours.size, ...count,
    pct_A_decoderExactToday: pct(count.A_decoderExact),
    pct_B_knowableWithBetterReader: pct(count.B_knowable),
    pct_C_notKnowable: pct(count.C_notKnowable),
    pct_singleSwap: pct(count.singleSwap), pct_allSwapsOnOurPools: pct(count.allSwapsOnOurPools), pct_toKnownRouter: pct(count.toKnownRouter),
    topSentTo: [...byTo.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([to, v]) => ({ to, n: v.n, decoderExact: v.A, knowable: v.B, known: !!registry.robinhood[to] })),
    nodeRequestsUsed: requests,
  };
  writeFileSync(join(OUT, 'trigger.json'), JSON.stringify(summary, null, 1));
  writeFileSync(join(OUT, 'per-tx.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log('SUMMARY ' + JSON.stringify(summary));
}
main().catch((e) => { console.error('ERROR', e?.message ?? e); process.exit(1); });
