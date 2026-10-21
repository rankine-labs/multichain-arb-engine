// ============================================================================
// PROFIT REPLAY (read only): was there money in it FOR US, in dollars?
//
// Plain English:
//   Takes a list of rival arbitrages (e.g. opp2/per-arb.jsonl from
//   measureOpp, or arbs.jsonl from liveReaction) and, for each one:
//     1. Reads what the rival actually made (its receipt: coins in vs out,
//        gas paid), in dollars, with the bot's own arbitrage reader and
//        price book (core/followMoney.ts).
//     2. Rebuilds the SAME route as OUR contract would trade it (same pools,
//        same direction, the bot's own hop builder). If our contract can't
//        trade one of the pools, it says so and counts it as "not ours".
//     3. Replays our trade on the chain state JUST BEFORE the rival's trade
//        (the block before + every earlier transaction in the same block,
//        replayed by the node: the bot's own replayRpc / eth_simulateV1),
//        with our real contract code, own money (the bot's live setting).
//     4. Tries several trade sizes and keeps the best one, both with no size
//        limit and within our own-money limit (OWN_MONEY_MAX_USD, $2,000).
//        Profit after the pools' fees comes from the contract itself; gas
//        is the gas our call really used in the replay, plus the L1 data
//        part the rival paid (similar size transaction), at the rival's gas
//        price, in dollars.
//   Writes <out>/profit.json (summary in counts AND dollars) and one line
//   per arbitrage (<out>/per-arb.jsonl).
//
// Safety: reads only. From the bot's .env only the --node URL line is read
// (never printed). Pretend-state calls only (nothing is signed or sent).
//
// Run (after `npx tsc -p scripts/sim-compare/tsconfig.json`):
//   node .scripts-build/scripts/sim-compare/measureProfit.js --arbs FILE
//        [--out DIR] [--rps 10] [--cap-usd 2000] [--limit N] [--node VAR]
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { ROBINHOOD_TOKENS } from '../../src/config/knownAddresses';
import { decodeSwapLog, classifyTx, receiptGasWei, obsFromSwap, buildPriceBook, priceArb, usdOf, sizeBucket, ArbRecord, PriceObs, PriceCtx } from '../../src/core/followMoney';
import { simulateRoundTrip, replayRpc, Rpc, ReplayCall, SimResult } from '../../src/execution/simulator';
import { kindForPool, hopFor, v4KeyMatchesId, KIND_V4_HOOKED, ExecutorHop } from '../../src/execution/executorCalldata';
import { DEFAULT_GAS_OWN } from '../../src/core/gasModel';

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const ARBS = arg('arbs');
const OUT = arg('out', `${process.env.HOME}/sim-compare-runs/profit1`)!;
const RPS = Number(arg('rps', '10'));
const CAP_USD = Number(arg('cap-usd', '2000'));     // the bot's own-money limit (OWN_MONEY_MAX_USD)
const LIMIT = Number(arg('limit', '0'));             // 0 = all
const NODE_VAR = arg('node', 'CHAINSTACK_RPC_ROBINHOOD')!;
if (!ARBS) { console.error('need --arbs FILE (jsonl with "arb" or "hash")'); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const lc = (s: string) => String(s ?? '').toLowerCase();
const WETH = lc(ROBINHOOD_TOKENS.WETH), USDG = lc(ROBINHOOD_TOKENS.USDG);
const RH_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const USER_TX_TYPES = new Set(['0x0', '0x1', '0x2', '0x3', '0x4']); // same as the bot (skip Arbitrum system txs)

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
// Rate-limited JSON-RPC that returns {result} or {error} (never throws), so it
// can be handed to the bot's simulator as its Rpc.
const rpc: Rpc = async (method, params) => {
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
  return { error: { message: 'network: gave up' } };
};

// --- watched pools (all of them: a rival route may use any we watch) ------
const watch = JSON.parse(readFileSync(join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'));
const pools = new Map<string, any>();
for (const p of watch.pools || []) if (p && p.chain === 'robinhood' && p.poolAddress && p.tokenA && p.tokenB) pools.set(lc(p.poolAddress), p);
// Which two coins a pool holds, in the pool's own order (token0, token1).
// V2/V3: sorted addresses. V4: currency0 = tokenA (native ETH = address 0).
function coinsOf(id: string): { c0: string; c1: string } | null {
  const p = pools.get(lc(id)); if (!p) return null;
  if (lc(id).length === 66) {
    const n = (t: string) => (p.v4?.native && lc(t) === WETH ? '0x0000000000000000000000000000000000000000' : lc(t));
    return { c0: n(p.tokenA), c1: n(p.tokenB) };
  }
  const [c0, c1] = [lc(p.tokenA), lc(p.tokenB)].sort();
  return { c0, c1 };
}
const asWeth = (t: string) => (/^0x0+$/.test(t) ? WETH : t);

// --- coin decimals / symbols (cached, read once per coin) -------------------
const ERC20 = new ethers.Interface(['function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const decs = new Map<string, number | null>(), syms = new Map<string, string>();
async function learnCoin(t: string) {
  t = lc(t); if (decs.has(t)) return;
  if (t === WETH) { decs.set(t, 18); syms.set(t, 'WETH'); return; }
  const d = await rpc('eth_call', [{ to: t, data: ERC20.encodeFunctionData('decimals') }, 'latest']);
  try { decs.set(t, Number(ERC20.decodeFunctionResult('decimals', d.result)[0])); } catch { decs.set(t, null); }
  const s = await rpc('eth_call', [{ to: t, data: ERC20.encodeFunctionData('symbol') }, 'latest']);
  try { syms.set(t, String(ERC20.decodeFunctionResult('symbol', s.result)[0]).slice(0, 12)); } catch { syms.set(t, t.slice(0, 8)); }
}

// --- our route from the rival's route ---------------------------------------
const missingPools = new Map<string, number>(); // pools rivals used that we don't watch -> how many arbitrages
type Built = { ok: true; token: string; hops: ExecutorHop[]; firstIn: bigint } | { ok: false; why: string };
// The route's coins and amounts read straight from the swap reports in the
// receipt (the arbitrage reader leaves them blank when it can't follow the
// coin transfers): for each swap, the coin the pool received went IN.
function fillHopsFromLogs(rec: ArbRecord, logs: any[]) {
  const legs: { pool: string; tin: string; tout: string; ain: bigint; aout: bigint }[] = [];
  for (const l of logs) {
    const s = decodeSwapLog(l); const cc = s && coinsOf(s.pool);
    if (!s || !cc || s.a0 === undefined || s.a1 === undefined || s.a0 === 0n || s.a1 === 0n) continue;
    const in0 = s.a0 > 0n;
    legs.push({ pool: lc(s.pool), tin: asWeth(in0 ? cc.c0 : cc.c1), tout: asWeth(in0 ? cc.c1 : cc.c0), ain: in0 ? s.a0 : s.a1, aout: -(in0 ? s.a1 : s.a0) });
  }
  // Only when every hop of the route is one of these swaps, in the same order.
  if (legs.length !== rec.hops.length || legs.some((g, i) => g.pool !== lc(rec.hops[i].pool))) return;
  legs.forEach((g, i) => { const h = rec.hops[i]; h.tin ??= g.tin; h.tout ??= g.tout; h.ain ??= g.ain.toString(); h.aout ??= g.aout.toString(); });
}
function ourRoute(rec: ArbRecord): Built {
  if (!rec.hops.length || rec.hops.length < 2) return { ok: false, why: 'fewer than 2 hops' };
  const missing = rec.hops.filter((h) => !pools.has(lc(h.pool)));
  if (missing.length) { for (const h of missing) missingPools.set(lc(h.pool), (missingPools.get(lc(h.pool)) ?? 0) + 1); return { ok: false, why: `${missing.length} of ${rec.hops.length} pools not on our watch list` }; }
  const hops: ExecutorHop[] = [];
  for (const h of rec.hops) {
    if (!h.tin || !h.tout) return { ok: false, why: 'route coins unreadable' };
    const p = pools.get(lc(h.pool));
    if (!p) return { ok: false, why: 'pool not on our watch list' };
    const kind = kindForPool(p);
    if (kind === null) return { ok: false, why: `${p.dex} pool type not supported by our contract` };
    if (kind === KIND_V4_HOOKED && !v4KeyMatchesId(p)) return { ok: false, why: `${p.dex} hooked V4 key mismatch` };
    // The pool's own spelling of the coin addresses (as the bot's loop builder does).
    const tin = lc(p.tokenA) === h.tin ? p.tokenA : lc(p.tokenB) === h.tin ? p.tokenB : null;
    const tout = lc(p.tokenA) === h.tout ? p.tokenA : lc(p.tokenB) === h.tout ? p.tokenB : null;
    if (!tin || !tout) return { ok: false, why: 'route coin not in pool' };
    try { hops.push(hopFor(kind, p, tin, tout)); } catch (e) { return { ok: false, why: `could not encode hop (${(e as Error).message})` }; }
  }
  for (let i = 1; i < hops.length; i++) if (lc(hops[i - 1].tokenOut) !== lc(hops[i].tokenIn)) return { ok: false, why: 'route does not chain' };
  if (lc(hops[0].tokenIn) !== lc(hops[hops.length - 1].tokenOut)) return { ok: false, why: 'not a loop (ends in another coin)' };
  const firstIn = rec.hops[0].ain ? BigInt(rec.hops[0].ain) : 0n;
  return { ok: true, token: hops[0].tokenIn, hops, firstIn };
}

async function main() {
  const lines = readFileSync(ARBS!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let list = lines.map((r) => ({ hash: lc(r.arb ?? r.hash), hadTrigger: r.trigger === undefined ? null : !!r.trigger, bucket: r.bucket ?? null, extra: r }))
    .filter((r) => r.hash.length === 66);
  if (LIMIT > 0) list = list.slice(0, LIMIT);
  console.log(`arbitrages to check: ${list.length}`);

  // 1. Receipts: classify each arbitrage + collect prices from every swap seen.
  const obs: PriceObs[] = [];
  const recs = new Map<string, { rec: ArbRecord; rc: any }>();
  const isQuote = (t: string) => t === USDG || t === WETH;
  for (const a of list) {
    const [tx, rc] = [await rpc('eth_getTransactionByHash', [a.hash]), await rpc('eth_getTransactionReceipt', [a.hash])];
    if (!tx.result || !rc.result) continue;
    const g = receiptGasWei(rc.result);
    const block = parseInt(rc.result.blockNumber, 16), txIndex = parseInt(rc.result.transactionIndex, 16);
    const c = classifyTx(rc.result.logs, tx.result.from, tx.result.to, rc.result.status,
      { hash: a.hash, block, txIndex, gasWei: g.gasWei, l1GasUsed: g.l1GasUsed, value: BigInt(tx.result.value ?? 0) },
      { weth: WETH, poolManager: RH_POOL_MANAGER, v4Currencies: (id) => coinsOf(id) });
    if (!c.arb) continue;
    fillHopsFromLogs(c.arb, rc.result.logs);
    recs.set(a.hash, { rec: c.arb, rc: rc.result });
    for (const l of rc.result.logs) {
      const s = decodeSwapLog(l); const cc = s && coinsOf(s.pool);
      if (!s || !cc || s.a0 === undefined || s.a1 === undefined) continue;
      const t0 = asWeth(cc.c0), t1 = asWeth(cc.c1);
      await learnCoin(t0); await learnCoin(t1);
      const d0 = decs.get(t0), d1 = decs.get(t1);
      if (d0 == null || d1 == null) continue;
      obs.push(...obsFromSwap(block, s.pool, t0, t1, s.a0, s.a1, d0, d1, isQuote));
    }
    for (const [t] of c.arb.net) await learnCoin(t);
    for (const h of c.arb.hops) { if (h.tin) await learnCoin(h.tin); if (h.tout) await learnCoin(h.tout); }
    if (recs.size % 100 === 0) console.log(`${recs.size} receipts · node requests ${requests}`);
  }
  obs.sort((x, y) => x.block - y.block);
  const book = buildPriceBook(obs, new Set([USDG]), WETH);
  const ctx: PriceCtx = {
    book, decimals: (t) => decs.get(lc(t)) ?? null, symbol: (t) => syms.get(lc(t)) ?? lc(t).slice(0, 8),
    dexOf: (p) => pools.get(lc(p))?.dex ?? '?', isWatched: (p) => pools.has(lc(p)), botCanTrade: () => true,
    timeOf: () => 0, timing: () => 'standalone',
  };
  console.log(`classified ${recs.size} arbitrages; price points ${obs.length}`);

  // 2. Per arbitrage: rival in dollars, then our replay at several sizes.
  const rows: any[] = [];
  const outFile = join(OUT, 'per-arb.jsonl'); writeFileSync(outFile, '');
  for (const a of list) {
    const got = recs.get(a.hash); if (!got) { rows.push({ hash: a.hash, skipped: 'not an arbitrage / no receipt' }); continue; }
    const { rec, rc } = got;
    const pr = priceArb(rec, ctx);
    const row: any = {
      hash: a.hash, block: rec.block, hadTrigger: a.hadTrigger, bucket: a.bucket, path: pr.path,
      rival: { sizeUsd: pr.sizeUsd, grossUsd: pr.grossUsd, gasUsd: pr.gasUsd, netUsd: pr.netUsd, trust: pr.trust, doubt: pr.doubtWhy },
    };
    const built = ourRoute(rec);
    if (built.ok === false) { row.ours = { status: 'not-ours', why: built.why }; rows.push(row); appendFileSync(outFile, JSON.stringify(row) + '\n'); continue; }
    // State just before the rival: block before + earlier transactions of the same block.
    const b = await rpc('eth_getBlockByNumber', ['0x' + rec.block.toString(16), true]);
    const txs: any[] = b.result?.transactions ?? [];
    const prefix: ReplayCall[] = txs.slice(0, rec.txIndex)
      .filter((t) => t.to && USER_TX_TYPES.has(String(t.type ?? '0x0').toLowerCase()))
      .map((t) => ({ from: t.from, to: t.to, data: t.input ?? t.data ?? '0x', value: t.value, gas: t.gas }));
    const sim = replayRpc(rpc, '0x' + (rec.block - 1).toString(16), prefix, b.result?.timestamp);
    const tokenUsd = book.usdAt(lc(built.token), rec.block);
    const dec = decs.get(lc(built.token));
    const eth = book.ethAt(rec.block);
    const gasPrice = BigInt(rc.effectiveGasPrice ?? rc.gasPrice ?? 0);
    const l1Gas = BigInt(rc.gasUsedForL1 ?? 0);
    const toUsd = (raw: bigint) => (tokenUsd && dec != null ? (Number(raw) / 10 ** dec) * tokenUsd.usd : null);
    const gasUsdOf = (r: SimResult) => (eth === null ? null : (Number(((('gasUsed' in r && r.gasUsed) ? r.gasUsed : BigInt(DEFAULT_GAS_OWN)) + l1Gas) * gasPrice) / 1e18) * eth);
    // Sizes: the rival's own size x 1/8 .. 4, plus our own-money limit.
    const base = built.firstIn > 0n ? built.firstIn : (tokenUsd && dec != null ? BigInt(Math.floor((500 / tokenUsd.usd) * 10 ** dec)) : 0n);
    const capRaw = tokenUsd && dec != null ? BigInt(Math.floor((CAP_USD / tokenUsd.usd) * 10 ** dec)) : null;
    const tried: { amt: bigint; r: SimResult }[] = [];
    const run = async (amt: bigint) => {
      if (amt <= 0n || tried.some((t) => t.amt === amt)) return;
      tried.push({ amt, r: await simulateRoundTrip(sim, 'robinhood', { token: built.token, amountIn: amt, hops: built.hops }, { weth: ROBINHOOD_TOKENS.WETH }) });
    };
    for (const m of [1n, 2n, 4n, 8n, 16n, 32n]) await run((base * m) / 8n);
    if (capRaw) await run(capRaw);
    const profitOf = (t: { r: SimResult }) => (t.r.status === 'profit' ? t.r.profit : -1n);
    let best = tried.reduce((x, y) => (profitOf(y) > profitOf(x) ? y : x), tried[0]);
    if (best && best.r.status === 'profit') { await run((best.amt * 7n) / 10n); await run((best.amt * 14n) / 10n); best = tried.reduce((x, y) => (profitOf(y) > profitOf(x) ? y : x), tried[0]); }
    const inCap = capRaw ? tried.filter((t) => t.amt <= capRaw) : tried;
    const bestCap = inCap.length ? inCap.reduce((x, y) => (profitOf(y) > profitOf(x) ? y : x), inCap[0]) : null;
    const describe = (t: { amt: bigint; r: SimResult } | null) => {
      if (!t) return null;
      const sizeUsd = toUsd(t.amt);
      if (t.r.status !== 'profit') return { status: t.r.status, why: 'reason' in t.r ? t.r.reason.slice(0, 80) : t.r.status === 'loss' ? 'loss' : undefined, sizeUsd };
      const grossUsd = toUsd(t.r.profit), gasUsd = gasUsdOf(t.r);
      return { status: 'profit', sizeUsd, grossUsd, gasUsd, netUsd: grossUsd === null ? null : grossUsd - (gasUsd ?? 0), gasUsed: t.r.gasUsed?.toString() };
    };
    row.ours = { status: best?.r.status ?? 'none', best: describe(best), withinCap: describe(bestCap), sims: tried.length, priceHow: tokenUsd?.how ?? 'none', thinPrice: !!tokenUsd && tokenUsd.volumeUsd < 1000 };
    rows.push(row); appendFileSync(outFile, JSON.stringify(row) + '\n');
    if (rows.length % 50 === 0) console.log(`${rows.length}/${list.length} replayed · node requests ${requests}`);
  }

  // 3. Summary: counts AND dollars, by group.
  const sum = (xs: (number | null | undefined)[]) => +xs.reduce<number>((s, x) => s + (typeof x === 'number' && isFinite(x) ? x : 0), 0).toFixed(2);
  const done = rows.filter((r) => r.rival);
  const trusted = (r: any) => r.rival.trust === 'ok';
  const oursNet = (r: any, k: 'best' | 'withinCap') => (r.ours?.[k]?.status === 'profit' && (r.ours[k].netUsd ?? 0) > 0 ? r.ours[k].netUsd : 0);
  const group = (name: string, rs: any[]) => ({
    group: name, arbs: rs.length,
    rivalNetUsd_trusted: sum(rs.filter(trusted).map((r) => r.rival.netUsd)),
    rivalNetUsd_all: sum(rs.map((r) => r.rival.netUsd)),
    ourRouteSupported: rs.filter((r) => r.ours && r.ours.status !== 'not-ours').length,
    weProfitAfterGas_noLimit: rs.filter((r) => oursNet(r, 'best') > 0).length,
    weProfitAfterGas_withinCap: rs.filter((r) => oursNet(r, 'withinCap') > 0).length,
    ourNetUsd_noLimit: sum(rs.map((r) => oursNet(r, 'best'))),
    ourNetUsd_withinCap: sum(rs.map((r) => oursNet(r, 'withinCap'))),
    ourNetUsd_withinCap_trustedPriceOnly: sum(rs.filter((r) => trusted(r) && !r.ours?.thinPrice).map((r) => oursNet(r, 'withinCap'))),
  });
  const groups = [group('all', done)];
  if (done.some((r) => r.hadTrigger !== null)) { groups.push(group('right after a trade (trigger)', done.filter((r) => r.hadTrigger))); groups.push(group('sitting gap / after another arb', done.filter((r) => r.hadTrigger === false))); }
  for (const bk of [...new Set(done.map((r) => r.bucket).filter(Boolean))]) groups.push(group(`gap age: ${bk}`, done.filter((r) => r.bucket === bk)));
  const bySize = new Map<string, any[]>();
  for (const r of done) { const k = sizeBucket(r.rival.sizeUsd); (bySize.get(k) ?? bySize.set(k, []).get(k)!).push(r); }
  const notOurs = new Map<string, number>();
  for (const r of done) if (r.ours?.status === 'not-ours') notOurs.set(r.ours.why, (notOurs.get(r.ours.why) ?? 0) + 1);
  const replayOutcome = new Map<string, number>();
  for (const r of done) if (r.ours && r.ours.status !== 'not-ours') { const k = r.ours.best?.status ?? r.ours.status; replayOutcome.set(k, (replayOutcome.get(k) ?? 0) + 1); }
  const summary = {
    arbsInFile: list.length, classified: recs.size, priced: done.length, ownMoneyLimitUsd: CAP_USD,
    rivalTrust: Object.fromEntries(['ok', 'doubtful', 'unpriced'].map((t) => [t, done.filter((r) => r.rival.trust === t).length])),
    groups,
    byRivalTradeSize: [...bySize.entries()].map(([k, rs]) => group(`rival size ${k}`, rs)),
    whyNotOurs: Object.fromEntries([...notOurs.entries()].sort((x, y) => y[1] - x[1])),
    ourReplayOutcome: Object.fromEntries(replayOutcome),
    unwatchedPoolsUsedByRivals: missingPools.size,
    topUnwatchedPools: [...missingPools.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([pool, n]) => ({ pool, arbs: n })),
    top10_ourNetWithinCap: done.filter((r) => oursNet(r, 'withinCap') > 0).sort((x, y) => oursNet(y, 'withinCap') - oursNet(x, 'withinCap')).slice(0, 10)
      .map((r) => ({ hash: r.hash, path: r.path, ourNetUsd: +oursNet(r, 'withinCap').toFixed(2), sizeUsd: r.ours.withinCap.sizeUsd && +r.ours.withinCap.sizeUsd.toFixed(0), rivalNetUsd: r.rival.netUsd && +r.rival.netUsd.toFixed(2) })),
    nodeRequestsUsed: requests,
  };
  writeFileSync(join(OUT, 'profit.json'), JSON.stringify(summary, null, 1));
  console.log('SUMMARY ' + JSON.stringify(summary));
}
main().catch((e) => { console.error('ERROR', e?.stack ?? e); process.exit(1); });
