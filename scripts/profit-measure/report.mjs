// ============================================================================
// PROFIT MEASURE - report step (no network). Reads the files measure.ts saved
// in results/profit-measure/ and writes summary.json + REPORT.md there.
//   node scripts/profit-measure/report.mjs [results dir]
// ============================================================================
import { readFileSync, writeFileSync, existsSync } from 'fs';

const DIR = process.argv[2] || 'results/profit-measure';
const rd = (f) => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
const lines = (f) => existsSync(`${DIR}/${f}`) ? readFileSync(`${DIR}/${f}`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const meta = rd('meta.json');
const timing = rd('timing.json');
const census = existsSync(`${DIR}/census.json`) ? rd('census.json') : null;
const arbs = lines('arbs.jsonl');
const prices = new Map(lines('arb-prices.jsonl').map((p) => [p.hash, p]));

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const OUR_EXEC = '0x7e0f847dd429e7c15ab08686d28710389c1f7837';
const OUR_SENDER = '0x09b4fb908ff646afa9c9878c082add7e4b3784d6';
const RIVALS = { '0x103b52a6': 'rival A (0x103b52a6..)', '0x9b5507bd': 'rival B (0x9b5507bd..)' };
const TRADEABLE = new Set(meta.tradeable);
const MAX_TRADE = 2000;          // MAX_TRADE_USD (own money)
const FAIL_GAS = 0.03;           // $ per failed attempt (owner's figure)
const MIN_NET = 0.25;            // the bot's minimum expected net profit
const msPerBlock = 1000 / meta.window.blocksPerSec;
const H = meta.window.hours;
const perDay = (x) => (x * 24) / H;

const tokDec = (t) => (t === '0x0000000000000000000000000000000000000000' ? 18 : meta.tokens[t]?.d ?? null);
const sym = (t) => (t === WETH ? 'WETH' : t === USDG ? 'USDG' : meta.tokens[t]?.s ?? t.slice(0, 8));
const pool = (p) => meta.poolInfo[p] ?? null;
const dexOf = (p) => pool(p)?.dex ?? (p.length === 66 ? 'uniswap-v4(?)' : 'unknown');
const pairOf = (p) => pool(p)?.pair ?? '?';
const short = (a) => `${a.slice(0, 10)}..${a.slice(-4)}`;
const fmt = (v) => (v === null || v === undefined || !isFinite(v) ? '?' : (v < 0 ? '-' : '') + '$' + (Math.abs(v) >= 1000 ? Math.round(Math.abs(v)).toLocaleString('en-US') : Math.abs(v).toFixed(2)));
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// Coverage per tier (receipts read / multi-pool txs) -> weight to scale up.
const cov = { 1: meta.tier1.read / Math.max(1, meta.tier1.total), 2: meta.tier2.read / Math.max(1, meta.tier2.total) };
const weightOf = (a) => 1 / Math.max(1e-9, cov[a.tier] ?? 1);

// One arbitrage in dollars.
function price(a) {
  const p = prices.get(a.hash);
  let gross = 0, unpriced = false, thin = false;
  a.net.forEach(([t, raw], i) => {
    const px = p?.net?.[i]?.[1]; const d = tokDec(t);
    if (!px || d === null) { unpriced = true; return; }
    if (t !== USDG && t !== WETH && px.vol < 1000) thin = true;
    gross += (Number(raw) / 10 ** d) * px.usd;
  });
  let size = null;
  const h0 = a.hops[0];
  if (h0?.tin && h0.ain && p?.hop0 && tokDec(h0.tin) !== null) size = (Number(h0.ain) / 10 ** tokDec(h0.tin)) * p.hop0.usd;
  const eth = p?.eth ?? meta.ethMid;
  const gas = (Number(a.gasWei) / 1e18) * eth;
  const grossUsd = unpriced ? null : gross;
  const doubtful = thin || (grossUsd !== null && size !== null && size > 0 && grossUsd > 0.05 * size) || (grossUsd !== null && size === null && grossUsd > 50) || a.uncertain.includes('v4-native-leg-hidden') || a.uncertain.includes('v4-pool-unknown');
  const coins = a.net.filter(([, v]) => BigInt(v) > 0n).map(([t]) => t);
  const profitCoin = coins.length === 1 ? sym(coins[0]) : coins.length ? 'mixed' : '?';
  const dexes = a.pools.map(dexOf);
  const allTradeable = dexes.every((d) => TRADEABLE.has(d));
  const baseCoin = coins.length >= 1 && coins.every((t) => t === USDG || t === WETH);
  const pairs = a.pools.map(pairOf);
  const twoSamePair = a.pools.length === 2 && pairs[0] === pairs[1] && pairs[0] !== '?';
  const tm = timing[a.hash] ?? {};
  return {
    a, gross: grossUsd, gas, net: grossUsd === null ? null : grossUsd - gas, size, trust: grossUsd === null ? 'unpriced' : doubtful ? 'doubtful' : 'ok',
    profitCoin, dexes, pairs, allTradeable, baseCoin, twoSamePair,
    ours2: twoSamePair && allTradeable && baseCoin, oursAny: allTradeable && baseCoin,
    bot: a.executor, w: weightOf(a), dBlocks: tm.dBlocks ?? null, arbBetween: tm.arbBetween ?? null, trigTo: tm.trigTo ?? null,
    isOurs: a.to === OUR_EXEC || a.executor === OUR_EXEC || a.from === OUR_SENDER,
  };
}
const P = arbs.map(price);
const ok = P.filter((x) => x.trust === 'ok');

// ---- Aggregates ------------------------------------------------------------
function agg(xs) {
  const nets = xs.map((x) => x.net);
  const est = (f) => xs.reduce((s, x) => s + f(x) * x.w, 0);
  return {
    trades: xs.length,
    tradesEst: Math.round(est(() => 1)),
    gross: xs.reduce((s, x) => s + x.gross, 0), gas: xs.reduce((s, x) => s + x.gas, 0), net: xs.reduce((s, x) => s + x.net, 0),
    netEst: est((x) => x.net), netPerDayEst: perDay(est((x) => x.net)), tradesPerDayEst: perDay(est(() => 1)),
    median: q(nets, 0.5), p90: q(nets, 0.9), max: nets.length ? Math.max(...nets) : null,
    over025: xs.filter((x) => x.net > 0.25).length, over1: xs.filter((x) => x.net > 1).length, over5: xs.filter((x) => x.net > 5).length,
    medianSize: q(xs.map((x) => x.size).filter((v) => v !== null), 0.5),
  };
}
const groups = {
  all_trusted: ok,
  base_coin_profit: ok.filter((x) => x.baseCoin),
  ours_any_route: ok.filter((x) => x.oursAny),
  ours_2pool_same_pair: ok.filter((x) => x.ours2),
};
const totals = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, agg(v)]));

// Who takes it (trusted, base-coin profit = what our bot would chase).
function byKey(xs, key) {
  const m = new Map();
  for (const x of xs) { for (const k of [].concat(key(x))) { const e = m.get(k) ?? []; e.push(x); m.set(k, e); } }
  return [...m.entries()].map(([k, v]) => ({ key: k, ...agg(v) })).sort((a, b) => b.netEst - a.netEst);
}
const botsAll = byKey(ok.filter((x) => x.baseCoin), (x) => x.bot);
const botsOurs = byKey(ok.filter((x) => x.oursAny), (x) => x.bot);
const poolsOurs = byKey(ok.filter((x) => x.oursAny), (x) => [...new Set(x.a.pools)]);
const pairsOurs = byKey(ok.filter((x) => x.oursAny), (x) => [...new Set(x.pairs)]);
const dexCombos = byKey(ok.filter((x) => x.baseCoin), (x) => [...new Set(x.dexes)].sort().join(' + '));
const routeLen = byKey(ok.filter((x) => x.baseCoin), (x) => (x.a.pools.length >= 4 ? '4+ pools' : `${x.a.pools.length} pools`));
const all = P;  // every arbitrage incl. doubtful/unpriced (counts only)
const trustCounts = { ok: ok.length, doubtful: P.filter((x) => x.trust === 'doubtful').length, unpriced: P.filter((x) => x.trust === 'unpriced').length };

// Timing: blocks after the opening trade, position in block.
function timingTable(xs) {
  const b = { 'same block': 0, '+1 block': 0, '+2 blocks': 0, '+3..10': 0, '>10 blocks': 0, 'no trade seen (within ~2000 blocks)': 0 };
  for (const x of xs) {
    const d = x.dBlocks;
    if (d === null) b['no trade seen (within ~2000 blocks)']++; else if (d === 0) b['same block']++; else if (d === 1) b['+1 block']++; else if (d === 2) b['+2 blocks']++; else if (d <= 10) b['+3..10']++; else b['>10 blocks']++;
  }
  return b;
}
const timingOurs = timingTable(ok.filter((x) => x.oursAny));
const timingAll = timingTable(ok.filter((x) => x.baseCoin));
const posTable = (xs) => { const m = {}; for (const x of xs) { const k = x.a.txIndex <= 1 ? '1 (first after system tx)' : x.a.txIndex <= 3 ? '2-3' : x.a.txIndex <= 10 ? '4-10' : '11+'; m[k] = (m[k] ?? 0) + 1; } return m; };
const posOurs = posTable(ok.filter((x) => x.oursAny));
const timingPerBot = botsOurs.slice(0, 8).map((b) => { const xs = ok.filter((x) => x.oursAny && x.bot === b.key); return { bot: b.key, ...timingTable(xs), medianBlocks: q(xs.map((x) => x.dBlocks).filter((v) => v !== null), 0.5) }; });

// Our own bot in the window and in the census.
const oursInWindow = P.filter((x) => x.isOurs);
const ourCensus = census ? census.ourTxs : [];
const censusHours = census?.censusTs?.from && census?.censusTs?.to ? (census.censusTs.to - census.censusTs.from) / 3600 : null;

// Census: complete picture (every receipt) of a recent stretch.
let censusBots = [];
if (census) {
  const cp = census.censusArbs.map((a) => ({ ...price({ ...a, tier: 0 }), w: 1 }));
  const cok = cp.filter((x) => x.trust === 'ok' && x.baseCoin);
  const m = byKey(cok, (x) => x.bot);
  const eth = meta.ethMid;
  censusBots = Object.entries(census.byTo).map(([to, e]) => {
    const g = m.find((x) => x.key === to);
    return { to, txs: e.n, ok: e.ok, failed: e.fail, arbs: e.arb, failRate: e.n ? e.fail / e.n : 0, gasUsd: (Number(e.gasWei) / 1e18) * eth, failGasUsd: (Number(e.failGasWei ?? 0) / 1e18) * eth, senders: e.senderCount, netTrusted: g?.net ?? 0, trustedArbs: g?.trades ?? 0 };
  }).filter((x) => x.arbs > 0 || x.failed > 20 || x.to === OUR_EXEC).sort((a, b) => b.netTrusted - a.netTrusted || b.arbs - a.arbs);
  census.summary = { hours: censusHours, arbs: census.censusArbs.length, trusted: agg(cok) };
}

// Realistic share for us: the "ours" chances (net >= $0.25), our size cap,
// capture share X, minus failed-attempt gas.
function scenario(xs, share, capUsd) {
  const chances = xs.filter((x) => x.net >= MIN_NET);
  let got = 0, n = 0;
  for (const x of chances) {
    let net = x.net;
    if (capUsd && x.size && x.size > capUsd) net = x.gross * (capUsd / x.size) - x.gas;  // linear scale-down (lower bound)
    got += net * x.w; n += x.w;
  }
  const win = got * share, fails = n * (1 - share) * FAIL_GAS;
  return { chancesPerDay: perDay(n), profitPerDay: perDay(win - fails), grossWinsPerDay: perDay(win), failGasPerDay: perDay(fails) };
}
const scen = [];
for (const [label, xs] of [['2-pool same pair (today\'s main route)', groups.ours_2pool_same_pair], ['any route on our exchanges (incl. loops)', groups.ours_any_route]]) {
  for (const share of [0.1, 0.25, 0.5, 1]) for (const cap of [MAX_TRADE, null]) scen.push({ routes: label, share, cap: cap ? `$${cap} own money` : 'no cap (flash loan)', ...scenario(xs, share, cap) });
}

const V4_MAIN = Object.keys(meta.poolInfo).find((p) => p.startsWith('0x462958d20c'));
const summary = {
  window: meta.window, coverage: { tier1: meta.tier1, tier2: meta.tier2 }, trustCounts, arbsFound: P.length,
  totals, botsAll: botsAll.slice(0, 15), botsOurs: botsOurs.slice(0, 15), poolsOurs: poolsOurs.slice(0, 20), pairsOurs: pairsOurs.slice(0, 15),
  dexCombos: dexCombos.slice(0, 12), routeLen, timingOurs, timingAll, timingPerBot, posOurs, v4MainPool: V4_MAIN ?? null,
  ourBot: { inWindow: oursInWindow.map((x) => ({ hash: x.a.hash, net: x.net, trust: x.trust, block: x.a.block })), census: ourCensus, nonce: meta.ourSender, censusHours },
  census: census ? { fromBlock: census.fromBlock, toBlock: census.toBlock, blocks: census.blocks, hours: censusHours, txs: census.txs, failed: census.failed, summary: census.summary, bots: censusBots.slice(0, 20) } : null,
  scenarios: scen, rpc: meta.rpc, minutes: meta.minutes,
};
writeFileSync(`${DIR}/summary.json`, JSON.stringify(summary, null, 1));

// ---- Markdown ------------------------------------------------------------------
const L = [];
const tbl = (head, rows) => { L.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`), ''); };
const name = (a) => { for (const [k, v] of Object.entries(RIVALS)) if (a.startsWith(k)) return v; return a === OUR_EXEC ? 'OUR BOT' : short(a); };
const iso = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
L.push(`# Robinhood Chain arbitrage: how much money is there? (profit measure)`, '');
L.push(`Window: ${iso(meta.window.fromTs)} to ${iso(meta.window.toTs)} (${H.toFixed(1)} h, blocks ${meta.window.fromBlock}-${meta.window.toBlock}). Read-only, public node.`, '');
L.push(`Swaps seen: ${meta.swaps.toLocaleString()} on ${meta.pools} pools. Multi-pool transactions: ${meta.multiPoolTxs.toLocaleString()}.`);
L.push(`Receipts read: our-bot-shape (tier 1) ${meta.tier1.read}/${meta.tier1.total} (${(100 * cov[1]).toFixed(0)}%), rest (tier 2) ${meta.tier2.read}/${meta.tier2.total} (${(100 * cov[2]).toFixed(0)}%). "Est." numbers scale the sample up by coverage.`);
L.push(`Arbitrage found: ${P.length} (trusted prices ${trustCounts.ok}, doubtful ${trustCounts.doubtful}, unpriced ${trustCounts.unpriced}). ETH ~${fmt(meta.ethMid)}.`, '');
L.push('## The money (trusted trades, after the gas they paid)', '');
tbl(['Group', 'Trades seen', 'Kept after gas (seen)', 'Est. per day', 'Est. trades/day', 'Median', 'p90', 'Max', '>$0.25', '>$1', '>$5', 'Median size'],
  Object.entries(totals).map(([k, t]) => [k.replace(/_/g, ' '), t.trades, fmt(t.net), fmt(t.netPerDayEst), Math.round(t.tradesPerDayEst), fmt(t.median), fmt(t.p90), fmt(t.max), t.over025, t.over1, t.over5, fmt(t.medianSize)]));
L.push('"ours" = every pool on an exchange our deployed contract can trade, profit taken in USDG or WETH. "2-pool same pair" = the bot\'s main route shape.', '');
L.push('## Who takes it (routes on our exchanges, USDG/WETH profit)', '');
tbl(['Bot contract', 'Trades', 'Kept (seen)', 'Est./day', 'Share', 'Median', 'Max'], botsOurs.slice(0, 12).map((b) => [name(b.key), b.trades, fmt(b.net), fmt(b.netPerDayEst), `${Math.round((100 * b.netEst) / Math.max(1e-9, totals.ours_any_route.netEst))}%`, fmt(b.median), fmt(b.max)]));
L.push('## Who takes it (all USDG/WETH-profit arbitrage, any exchange)', '');
tbl(['Bot contract', 'Trades', 'Kept (seen)', 'Est./day', 'Share'], botsAll.slice(0, 12).map((b) => [name(b.key), b.trades, fmt(b.net), fmt(b.netPerDayEst), `${Math.round((100 * b.netEst) / Math.max(1e-9, totals.base_coin_profit.netEst))}%`]));
L.push('## Which pools carry the money (our exchanges)', '');
tbl(['Pool', 'Exchange', 'Pair', 'Trades', 'Est./day', 'Swaps in window'], poolsOurs.slice(0, 15).map((p) => [short(p.key) + (p.key === V4_MAIN ? ' (V4 WETH/USDG main)' : ''), dexOf(p.key), pairOf(p.key), p.trades, fmt(p.netPerDayEst), meta.poolSwaps[p.key] ?? '?']));
L.push('## Pairs (our exchanges)', '');
tbl(['Pair', 'Trades', 'Est./day'], pairsOurs.slice(0, 10).map((p) => [p.key, p.trades, fmt(p.netPerDayEst)]));
L.push('## Route length / exchange mix (USDG/WETH profit, any exchange)', '');
tbl(['Route', 'Trades', 'Est./day'], routeLen.map((r) => [r.key, r.trades, fmt(r.netPerDayEst)]));
tbl(['Exchanges used', 'Trades', 'Est./day'], dexCombos.slice(0, 10).map((r) => [r.key, r.trades, fmt(r.netPerDayEst)]));
L.push('## Speed: when did the winner land after the trade that opened the gap?', '');
L.push(`One block is about ${msPerBlock.toFixed(0)} ms.`, '');
tbl(['Delay', 'Our exchanges', 'All (USDG/WETH profit)'], Object.keys(timingOurs).map((k) => [k, timingOurs[k], timingAll[k]]));
tbl(['Bot', 'same block', '+1', '+2', '+3..10', '>10', 'none seen', 'median blocks'], timingPerBot.map((t) => [name(t.bot), t['same block'], t['+1 block'], t['+2 blocks'], t['+3..10'], t['>10 blocks'], t['no trade seen (within ~2000 blocks)'], t.medianBlocks ?? '?']));
tbl(['Position in block', 'Trades (our exchanges)'], Object.entries(posOurs));
if (census) {
  L.push(`## Census: EVERY transaction in ${census.blocks.toLocaleString()} recent blocks (${censusHours?.toFixed(2)} h, incl. failed ones)`, '');
  L.push(`Transactions: ${census.txs.toLocaleString()}, failed ${census.failed.toLocaleString()}. Arbitrage: ${census.censusArbs.length}; trusted USDG/WETH profit kept ${fmt(census.summary.trusted.net)} (${fmt(census.summary.trusted.net * 24 / Math.max(0.01, censusHours ?? 1))}/day pace).`, '');
  tbl(['Contract', 'Txs', 'Failed', 'Fail rate', 'Arbs', 'Trusted kept', 'Gas paid', 'Gas on fails', 'Wallets'], censusBots.slice(0, 15).map((b) => [name(b.to), b.txs, b.failed, `${Math.round(100 * b.failRate)}%`, b.arbs, fmt(b.netTrusted), fmt(b.gasUsd), fmt(b.failGasUsd), b.senders]));
}
L.push('## Our bot', '');
L.push(`Successful arbitrage by our executor in the window: ${oursInWindow.length} (${oursInWindow.filter((x) => x.trust === 'ok').map((x) => fmt(x.net)).join(', ') || 'none'}).`);
L.push(`Sender nonce: ${meta.ourSender.nonceStart} at the window end -> ${meta.ourSender.nonceEnd} at block ${meta.ourSender.nonceEndBlock} (= ${meta.ourSender.nonceEnd - meta.ourSender.nonceStart} transactions sent while this job ran).`);
if (census) { const s = ourCensus; L.push(`In the census: ${s.length} of our transactions, ${s.filter((x) => x.ok).length} succeeded, ${s.filter((x) => x.arb).length} were profitable arbitrage, ${s.filter((x) => !x.ok).length} failed.`); }
L.push('');
L.push('## Realistic share for us (per day)', '');
L.push(`Chances = trusted trades with net >= $${MIN_NET} on our exchanges. Win share X = fraction of those we win. Each lost race costs ~$${FAIL_GAS} gas. Size cap scales profit down linearly (a lower bound).`, '');
tbl(['Routes', 'Win share', 'Money', 'Chances/day', 'Our profit/day', 'Wins', 'Lost-race gas'], scen.map((s) => [s.routes, `${s.share * 100}%`, s.cap, Math.round(s.chancesPerDay), fmt(s.profitPerDay), fmt(s.grossWinsPerDay), fmt(s.failGasPerDay)]));
L.push('## Caveats', '');
L.push('- Arbitrage is detected from coin movements (bot ends with more of a coin and less of none). Exchanges whose swaps leave no known event are invisible; failed attempts are only visible in the census section.');
L.push('- "Trusted" = all profit coins priced from a busy pool and profit under 5% of trade size. Doubtful/unpriced trades (mostly thin meme coins) are left out of the dollars.');
L.push('- Per-day numbers scale the sampled receipts up by coverage and the window up to 24 h; time-of-day swings are not corrected.');
L.push(`- "Our exchanges" = ${[...TRADEABLE].join(', ')} (unhooked V4 only; Algebra and hooked V4 need a contract redeploy). The real watch list lives on the server and was not used.`);
L.push(`- Node requests: ${meta.rpc.http} HTTP (${meta.rpc.calls} calls), 429 answers ${meta.rpc.limited}. Run took ${meta.minutes.toFixed(0)} min.`);
writeFileSync(`${DIR}/REPORT.md`, L.join('\n') + '\n');
console.log(L.join('\n'));
