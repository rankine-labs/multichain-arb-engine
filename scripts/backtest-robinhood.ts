// ============================================================================
// ROBINHOOD BACKTEST (diagnostic): replays the last N days of trades on the
// pairs the bot watches and reports the arbitrage opportunities that existed.
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/backtest-robinhood.js
// Env: ROBINHOOD_RPC_URL, BACKTEST_DAYS (7), BACKTEST_PAIRS (20),
//      FLASH_FEE (0.0005), GAS_USD (0.05), MAX_TRADE_USD (50000)
// Never touches the server or any funds.
// ============================================================================
import { ethers } from 'ethers';
import { scanUniverse, makeCaller, getLogsAdaptive, RawLog } from '../src/core/universeScan';
import { ROBINHOOD_SCAN_FACTORIES, ROBINHOOD_TOKENS } from '../src/config/knownAddresses';
import { BacktestEngine, BtPool, BtEvent, decodePoolEvent, Opportunity } from '../src/core/backtest';

const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const DAYS = Number(process.env.BACKTEST_DAYS ?? 7);
const PAIRS = Number(process.env.BACKTEST_PAIRS ?? 20);
const FLASH_FEE = Number(process.env.FLASH_FEE ?? 0.0005);
const GAS_USD = Number(process.env.GAS_USD ?? 0.05);
const MAX_TRADE_USD = Number(process.env.MAX_TRADE_USD ?? 50_000);
const V2_FEES: Record<string, number> = { 'uniswap-v2': 0.003, 'pancakeswap-v2': 0.0025, 'ramses-v2': 0.002 };

const say = (m: string) => console.log(m);
const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v).toLocaleString('en-US')}`);
const lc = (a: string) => a.toLowerCase();

async function main() {
  const t0 = Date.now();
  const USDG = lc(ROBINHOOD_TOKENS.USDG), WETH = lc(ROBINHOOD_TOKENS.WETH);

  // 1) Which pairs: the same top pairs the bot pins.
  const scan = await scanUniverse(provider, ROBINHOOD_SCAN_FACTORIES, { usdToken: USDG, wrappedNative: WETH });
  const cands = scan.candidates.slice(0, PAIRS);
  const ethUsd = scan.usdPrice.get(WETH) ?? 0;
  const sym = (t: string) => scan.tokens.get(lc(t))?.symbol ?? t.slice(0, 8);
  const dec = (t: string) => scan.tokens.get(lc(t))?.decimals ?? 18;
  say(`[bt] scan done: ${cands.length} pairs, ETH ~${usd(ethUsd)} (${Math.round((Date.now() - t0) / 1000)}s)`);

  // 2) Their pools, with fees (V3: read fee(); V2: known per DEX).
  const raw = cands.flatMap((c) => c.pools);
  const { callMany } = await makeCaller(provider);
  const feeIface = new ethers.Interface(['function fee() view returns (uint24)']);
  const v3 = raw.filter((p) => p.kind === 'v3');
  const feeRes = await callMany(v3.map((p) => ({ target: p.pool, data: feeIface.encodeFunctionData('fee') })));
  const v3Fee = new Map(v3.map((p, i) => [lc(p.pool), feeRes[i] ? Number(BigInt(feeRes[i]!.slice(0, 66))) / 1e6 : 0.003]));
  const pools: BtPool[] = raw.map((p) => ({
    address: lc(p.pool), dex: p.dex, kind: p.kind, token0: lc(p.token0), token1: lc(p.token1),
    dec0: dec(p.token0), dec1: dec(p.token1),
    fee: p.kind === 'v3' ? (v3Fee.get(lc(p.pool)) ?? 0.003) : (V2_FEES[p.dex] ?? 0.003),
  }));
  say(`[bt] ${pools.length} pools (${v3.length} V3)`);

  // 3) The time window: blocks for the last DAYS days.
  const latest = await provider.getBlockNumber();
  const tip = await provider.getBlock(latest);
  const probeBlock = Math.max(1, latest - 2_000_000);
  const probe = await provider.getBlock(probeBlock);
  const secPerBlock = (tip!.timestamp - probe!.timestamp) / (latest - probeBlock);
  const fromBlock = Math.max(1, Math.floor(latest - (DAYS * 86400) / secPerBlock));
  const fromTs = tip!.timestamp - (latest - fromBlock) * secPerBlock;
  const tsOf = (b: number) => fromTs + (b - fromBlock) * secPerBlock;
  say(`[bt] window: blocks ${fromBlock}-${latest} (${(secPerBlock * 1000).toFixed(0)} ms/block)`);

  // 4) Starting state at the first block (needs historical state; optional).
  const pick = (t0: string, t1: string) =>
    t0 === USDG || t1 === USDG ? { quote: USDG, usd: 1 } : t0 === WETH || t1 === WETH ? { quote: WETH, usd: ethUsd } : null;
  const engines = [5, 20, 100].map((min) => new BacktestEngine(pools, pick, sym,
    { minProfitUsd: min, flashFee: FLASH_FEE, gasUsd: GAS_USD, maxTradeUsd: MAX_TRADE_USD }));
  const st = new ethers.Interface([
    'function slot0() view returns (uint160, int24)', 'function liquidity() view returns (uint128)',
    'function getReserves() view returns (uint256, uint256)',
  ]);
  let seeded = 0;
  for (const p of pools) {
    try {
      if (p.kind === 'v3') {
        const s0 = await provider.call({ to: p.address, data: st.encodeFunctionData('slot0'), blockTag: fromBlock });
        const lq = await provider.call({ to: p.address, data: st.encodeFunctionData('liquidity'), blockTag: fromBlock });
        const state = { kind: 'v3' as const, sqrtPriceX96: BigInt(s0.slice(0, 66)), liquidity: BigInt(lq.slice(0, 66)) };
        engines.forEach((e) => e.setState(p.address, state));
      } else {
        const rr = await provider.call({ to: p.address, data: st.encodeFunctionData('getReserves'), blockTag: fromBlock });
        const state = { kind: 'v2' as const, r0: BigInt(rr.slice(0, 66)), r1: BigInt('0x' + rr.slice(66, 130)) };
        engines.forEach((e) => e.setState(p.address, state));
      }
      seeded++;
    } catch { /* no historical state for this pool: it joins at its first event */ }
  }
  say(`[bt] starting state for ${seeded}/${pools.length} pools`);

  // 5) Every event from those pools in the window, decoded as it arrives
  //    (raw logs are dropped right away: a week is a lot of data).
  const kindOf = new Map(pools.map((p) => [p.address, p.kind]));
  const events: BtEvent[] = [];
  let rawCount = 0, lastNote = Date.now();
  await getLogsAdaptive(provider, pools.map((p) => p.address), fromBlock, latest, (ls) => {
    rawCount += ls.length;
    for (const l of ls) {
      const pool = lc(l.address ?? '');
      const kind = kindOf.get(pool);
      if (!kind) continue;
      const state = decodePoolEvent(kind, l);
      if (state) events.push({ block: Number(l.blockNumber), logIndex: Number(l.logIndex), pool, state });
    }
    if (Date.now() - lastNote > 60_000) { lastNote = Date.now(); say(`[bt] ...${rawCount} events so far`); }
  });
  say(`[bt] ${rawCount} pool events fetched, ${events.length} price updates (${Math.round((Date.now() - t0) / 1000)}s)`);

  // 6) Replay in order.
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const ev of events) for (const e of engines) e.apply(ev);
  for (const e of engines) e.finish(latest);
  const swapsPerPool = new Map<string, number>();
  for (const ev of events) swapsPerPool.set(ev.pool, (swapsPerPool.get(ev.pool) ?? 0) + 1);

  // 7) Report.
  const [e5, e20, e100] = engines;
  const ops = e20.opportunities;
  const sameBlock = ops.filter((o) => o.closedSameBlock);
  const lasted = ops.filter((o) => !o.closedSameBlock);
  const total = (os: Opportunity[]) => os.reduce((s, o) => s + o.peakUsd, 0);
  const secs = (o: Opportunity) => (o.endBlock - o.startBlock) * secPerBlock;
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

  const out: string[] = [];
  out.push(`ROBINHOOD BACKTEST · last ${DAYS} days · ${cands.length} pairs · ${pools.length} pools · ${events.length.toLocaleString('en-US')} price updates`);
  out.push(`Assumes: flash fee ${(FLASH_FEE * 100).toFixed(2)}%, gas $${GAS_USD}, max trade ${usd(MAX_TRADE_USD)}, profit after all fees`);
  out.push('');
  out.push(`Opportunities worth $5+: ${e5.opportunities.length} · $20+: ${ops.length} · $100+: ${e100.opportunities.length}`);
  out.push(`$20+ per day: ${(ops.length / DAYS).toFixed(1)} · median peak ${usd(median(ops.map((o) => o.peakUsd)))} · biggest ${usd(Math.max(0, ...ops.map((o) => o.peakUsd)))}`);
  out.push(`Sum of peaks ($20+): ${usd(total(ops))} over ${DAYS} days (~${usd(total(ops) / DAYS)}/day) = upper bound if we won every one`);
  out.push('');
  out.push(`COMPETITION ($20+)`);
  out.push(`Closed in the same block (another bot took it): ${sameBlock.length} (${ops.length ? Math.round((100 * sameBlock.length) / ops.length) : 0}%), worth ${usd(total(sameBlock))}`);
  out.push(`Stayed open 1+ blocks: ${lasted.length}, worth ${usd(total(lasted))} · median open ${median(lasted.map(secs)).toFixed(1)}s`);
  out.push(`Stayed open 10s+: ${lasted.filter((o) => secs(o) >= 10).length}, worth ${usd(total(lasted.filter((o) => secs(o) >= 10)))}`);
  out.push('');
  out.push('BY PAIR ($20+): count · total peaks · usual route');
  const byPair = new Map<string, Opportunity[]>();
  for (const o of ops) (byPair.get(o.pair) ?? byPair.set(o.pair, []).get(o.pair)!).push(o);
  [...byPair.entries()].sort((a, b) => total(b[1]) - total(a[1])).slice(0, 10).forEach(([pair, os]) => {
    const routes = new Map<string, number>();
    for (const o of os) { const r = `${o.buyDex}>${o.sellDex}`; routes.set(r, (routes.get(r) ?? 0) + 1); }
    const top = [...routes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    out.push(`${pair}: ${os.length} · ${usd(total(os))} · ${top}`);
  });
  if (!byPair.size) out.push('none');
  out.push('');
  out.push('BY DAY ($20+): ' + Array.from({ length: DAYS }, (_, i) => {
    const dayStart = fromTs + i * 86400, dayEnd = dayStart + 86400;
    const n = ops.filter((o) => tsOf(o.startBlock) >= dayStart && tsOf(o.startBlock) < dayEnd).length;
    return `${new Date(dayStart * 1000).toISOString().slice(5, 10)}: ${n}`;
  }).join(' · '));
  const busiest = [...swapsPerPool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([a, n]) => { const p = pools.find((x) => x.address === a)!; return `${sym(p.token0)}/${sym(p.token1)} ${p.dex} ${(p.fee * 100).toFixed(2)}%: ${n}`; });
  out.push(`Busiest pools: ${busiest.join(' · ')}`);
  out.push(`Data: start state for ${seeded}/${pools.length} pools · ${Math.round((Date.now() - t0) / 1000)}s total`);
  console.log(out.join('\n'));
  process.exit(0);
}

main().catch((err) => { console.log(`backtest crashed: ${(err as Error).message}`); process.exit(0); });
