// ============================================================================
// BIG WIN CHECK (research, read-only, never sends anything)
//
// Plain English:
//   On Oct 11 the bot logged a $535 practice win: buy on UP CL, sell on
//   Uniswap V2, in USDG. This script replays today's prices to find it:
//     1. List every UP CL pool that trades a coin against USDG.
//     2. For each, find the same coin's Uniswap V2 pool against USDG.
//     3. Read every price change today on both pools (UP swaps, V2 reserve
//        updates) and track the price gap between them, event by event.
//     4. Report the biggest gaps: when they opened, what caused them (which
//        transaction, how big), how long they lasted, how deep each pool
//        was, and who closed the gap (a rival bot doing both pools in one
//        transaction, or a normal trade).
//   Results are printed as GitHub annotations.
//
// Settings: BIGWIN_FROM_UTC (ISO time to start from, default today 00:00
// Toronto), BIGWIN_PACE_MS (default 400), BIGWIN_MIN_GAP_PCT (default 2).
// ============================================================================
import { ethers } from 'ethers';
import { ROBINHOOD_TOKENS, ROBINHOOD_V2 } from '../src/config/knownAddresses';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const PACE = Number(process.env.BIGWIN_PACE_MS ?? 400);
const MIN_GAP = Number(process.env.BIGWIN_MIN_GAP_PCT ?? 2);
const UP_FACTORY = '0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3';
const USDG = ROBINHOOD_TOKENS.USDG.toLowerCase();
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Event fingerprints.
const T_V3_SWAP = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const T_V2_SYNC = ethers.id('Sync(uint112,uint112)');
const T_INIT = ethers.id('Initialize(uint160,int24)');
const T_ANY_SWAPS = [
  T_V3_SWAP,
  ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'),
  ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const provider = new ethers.JsonRpcProvider(URL_, 4663, { staticNetwork: true, batchMaxCount: 1 });
let lastCall = 0;
// One request at a time, paced, with retries when the free node pushes back.
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCall + PACE - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try { return await provider.send(method, params); }
    catch (e) {
      const m = String((e as any)?.message ?? e);
      if (/403|429|rate|too many|timeout/i.test(m)) { await sleep(2_000 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw new Error(`${method}: node kept refusing`);
}

// Many read-only calls bundled into one request (Multicall3).
const mc3 = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
async function callMany(calls: { target: string; data: string }[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += 250) {
    const slice = calls.slice(i, i + 250);
    const data = mc3.encodeFunctionData('aggregate3', [slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
    try {
      const [res] = mc3.decodeFunctionResult('aggregate3', await rpc('eth_call', [{ to: MC3, data }, 'latest']));
      out.push(...res.map((r: any) => (r.success && r.returnData !== '0x' ? r.returnData : null)));
    } catch { out.push(...slice.map(() => null)); }
  }
  return out;
}
const SEL = (sig: string) => ethers.id(sig).slice(0, 10);
const word = (r: string | null, i = 0): bigint | null => (r && r.length >= 2 + 64 * (i + 1) ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null);
const addrOf = (r: string | null) => (r && r.length >= 66 ? '0x' + r.slice(26, 66).toLowerCase() : null);
const signed = (v: bigint) => (v >= 1n << 255n ? v - (1n << 256n) : v);
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const toronto = (ts: number) => new Date(ts * 1000).toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: false });

function annotate(title: string, lines: string[]) {
  const body = lines.join('\n');
  console.log(`----- ${title} -----\n${body}`);
  console.log(`::notice title=${title}::${body.replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
}

// Find the first block at or after a timestamp (binary search on block times).
async function blockAt(ts: number, head: number): Promise<number> {
  let lo = Math.max(1, head - 2_000_000), hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await rpc('eth_getBlockByNumber', [ethers.toQuantity(mid), false]);
    if (Number(b.timestamp) < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Read logs over a long range in chunks; shrink the chunk if the node refuses.
async function logsRange(filter: object, from: number, to: number): Promise<any[]> {
  const out: any[] = [];
  let step = 50_000;
  for (let a = from; a <= to;) {
    const b = Math.min(to, a + step - 1);
    try {
      out.push(...(await rpc('eth_getLogs', [{ ...filter, fromBlock: ethers.toQuantity(a), toBlock: ethers.toQuantity(b) }])));
      a = b + 1;
    } catch (e) {
      if (step <= 500) throw e;
      step = Math.floor(step / 4);
    }
  }
  return out;
}

const blockTime = new Map<number, number>();
async function tsOf(block: number): Promise<number> {
  if (!blockTime.has(block)) blockTime.set(block, Number((await rpc('eth_getBlockByNumber', [ethers.toQuantity(block), false])).timestamp));
  return blockTime.get(block)!;
}

interface Pair { coin: string; sym: string; coinDec: number; usdgDec: number; up: string; upUsdgIs0: boolean; v2: string; v2UsdgIs0: boolean }

async function main() {
  const head = Number(await rpc('eth_blockNumber', []));
  const headTs = await tsOf(head);
  const fromIso = process.env.BIGWIN_FROM_UTC || (() => {
    // Midnight Toronto today (EDT = UTC-4 in October).
    const d = new Date(headTs * 1000 - 4 * 3600_000);
    return `${d.toISOString().slice(0, 10)}T04:00:00Z`;
  })();
  const fromTs = Math.floor(Date.parse(fromIso) / 1000);
  const fromBlock = await blockAt(fromTs, head);
  console.log(`window: blocks ${fromBlock}..${head} (${toronto(fromTs)} to ${toronto(headTs)} Toronto)`);

  // 1. Every UP CL pool, keep the ones with USDG on one side.
  const nRes = await callMany([{ target: UP_FACTORY, data: SEL('allPoolsLength()') }]);
  const n = Number(word(nRes[0]) ?? 0n);
  const poolRes = await callMany([...Array(n).keys()].map((i) => ({ target: UP_FACTORY, data: SEL('allPools(uint256)') + pad(ethers.toBeHex(i)) })));
  const pools = poolRes.map(addrOf).filter((x): x is string => !!x);
  const tok = await callMany(pools.flatMap((p) => [{ target: p, data: SEL('token0()') }, { target: p, data: SEL('token1()') }]));
  const upUsdg: { pool: string; coin: string; usdgIs0: boolean }[] = [];
  pools.forEach((p, i) => {
    const t0 = addrOf(tok[2 * i]), t1 = addrOf(tok[2 * i + 1]);
    if (t0 === USDG && t1) upUsdg.push({ pool: p, coin: t1, usdgIs0: true });
    else if (t1 === USDG && t0) upUsdg.push({ pool: p, coin: t0, usdgIs0: false });
  });
  console.log(`UP CL pools: ${pools.length}, with USDG: ${upUsdg.length}`);

  // 2. Matching Uniswap V2 pool (coin/USDG), coin symbol and decimals.
  const info = await callMany(upUsdg.flatMap((u) => [
    { target: ROBINHOOD_V2.FACTORY, data: SEL('getPair(address,address)') + pad(u.coin) + pad(USDG) },
    { target: u.coin, data: SEL('symbol()') },
    { target: u.coin, data: SEL('decimals()') },
  ]).concat([{ target: USDG, data: SEL('decimals()') }]));
  const usdgDec = Number(word(info[info.length - 1]) ?? 6n);
  const pairs: Pair[] = [];
  upUsdg.forEach((u, i) => {
    const v2 = addrOf(info[3 * i]);
    if (!v2 || v2 === ethers.ZeroAddress) return;
    let sym = '?';
    try { sym = ethers.AbiCoder.defaultAbiCoder().decode(['string'], info[3 * i + 1]!)[0]; } catch { /* odd symbol */ }
    pairs.push({ coin: u.coin, sym, coinDec: Number(word(info[3 * i + 2]) ?? 18n), usdgDec, up: u.pool, upUsdgIs0: u.usdgIs0, v2, v2UsdgIs0: USDG < u.coin });
  });
  console.log(`coins on both UP CL and Uniswap V2 (vs USDG): ${pairs.map((p) => p.sym).join(', ')}`);
  if (!pairs.length) { annotate('Big win check', ['No coin trades against USDG on both UP CL and Uniswap V2.']); return; }

  // 3. Every price change today on those pools.
  const upLogs = await logsRange({ address: pairs.map((p) => p.up), topics: [[T_V3_SWAP, T_INIT]] }, fromBlock, head);
  const v2Logs = await logsRange({ address: pairs.map((p) => p.v2), topics: [T_V2_SYNC] }, fromBlock, head);
  console.log(`events: ${upLogs.length} UP CL, ${v2Logs.length} Uniswap V2`);

  // Coin price in USDG from each kind of event.
  const upPrice = (p: Pair, sqrtP: bigint) => {
    const raw = (Number(sqrtP) / 2 ** 96) ** 2; // token1 per token0, raw units
    const t1per0 = raw * 10 ** ((p.upUsdgIs0 ? p.usdgDec : p.coinDec) - (p.upUsdgIs0 ? p.coinDec : p.usdgDec));
    return p.upUsdgIs0 ? 1 / t1per0 : t1per0;
  };
  const v2State = (p: Pair, data: string) => {
    const r0 = Number(BigInt('0x' + data.slice(2, 66))), r1 = Number(BigInt('0x' + data.slice(66, 130)));
    const usdg = (p.v2UsdgIs0 ? r0 : r1) / 10 ** p.usdgDec, coin = (p.v2UsdgIs0 ? r1 : r0) / 10 ** p.coinDec;
    return { price: coin > 0 ? usdg / coin : 0, usdgSide: usdg };
  };

  interface Ev { block: number; idx: number; tx: string; kind: 'up' | 'v2'; price: number; usdgMoved?: number; v2Usdg?: number; liq?: bigint }
  interface Episode { pair: Pair; openBlock: number; openTx: string; openKind: string; openUsdg?: number; maxGap: number; maxBlock: number; upPrice: number; v2Price: number; v2Usdg: number; upLiq?: bigint; closeBlock?: number; closeTx?: string }
  const episodes: Episode[] = [];
  for (const p of pairs) {
    const evs: Ev[] = [];
    for (const l of upLogs) if (l.address.toLowerCase() === p.up) {
      const base = { block: Number(l.blockNumber), idx: Number(l.logIndex), tx: l.transactionHash, kind: 'up' as const };
      if (l.topics[0] === T_INIT) { evs.push({ ...base, price: upPrice(p, BigInt('0x' + l.data.slice(2, 66))) }); continue; }
      const a0 = signed(BigInt('0x' + l.data.slice(2, 66))), a1 = signed(BigInt('0x' + l.data.slice(66, 130)));
      const sqrtP = BigInt('0x' + l.data.slice(130, 194)), liq = BigInt('0x' + l.data.slice(194, 258));
      const usdgAmt = Math.abs(Number(p.upUsdgIs0 ? a0 : a1)) / 10 ** p.usdgDec;
      evs.push({ ...base, price: upPrice(p, sqrtP), usdgMoved: usdgAmt, liq });
    }
    for (const l of v2Logs) if (l.address.toLowerCase() === p.v2) {
      const s = v2State(p, l.data);
      evs.push({ block: Number(l.blockNumber), idx: Number(l.logIndex), tx: l.transactionHash, kind: 'v2', price: s.price, v2Usdg: s.usdgSide });
    }
    evs.sort((a, b) => a.block - b.block || a.idx - b.idx);
    // Walk the events, tracking both prices and the gap between them.
    let up: Ev | null = null, v2: Ev | null = null, ep: Episode | null = null;
    for (const e of evs) {
      if (e.kind === 'up') up = e; else v2 = e;
      if (!up || !v2 || !up.price || !v2.price) continue;
      const gap = (v2.price / up.price - 1) * 100; // positive = UP cheaper (buy UP, sell V2)
      if (gap >= MIN_GAP) {
        if (!ep) ep = { pair: p, openBlock: e.block, openTx: e.tx, openKind: e.kind === 'up' ? 'UP CL trade' : 'Uniswap V2 trade', openUsdg: e.usdgMoved, maxGap: gap, maxBlock: e.block, upPrice: up.price, v2Price: v2.price, v2Usdg: v2.v2Usdg ?? 0, upLiq: up.liq };
        if (gap > ep.maxGap) Object.assign(ep, { maxGap: gap, maxBlock: e.block, upPrice: up.price, v2Price: v2.price, v2Usdg: v2.v2Usdg ?? 0, upLiq: up.liq ?? ep.upLiq });
      } else if (ep) {
        ep.closeBlock = e.block; ep.closeTx = e.tx;
        episodes.push(ep); ep = null;
      }
    }
    if (ep) episodes.push(ep);
  }
  episodes.sort((a, b) => b.maxGap * Math.min(b.v2Usdg, 1e6) - a.maxGap * Math.min(a.v2Usdg, 1e6));

  // 4. Details for the top episodes: who caused it, who closed it.
  const lines: string[] = [`Window ${toronto(fromTs)} to ${toronto(headTs)} Toronto. ${pairs.length} coins on both UP CL and Uniswap V2. Gaps of ${MIN_GAP}%+ (UP cheaper): ${episodes.length}.`];
  for (const ep of episodes.slice(0, 6)) {
    const openTs = await tsOf(ep.openBlock);
    let opener = '?', closer = 'still open at the end';
    try { const tx = await rpc('eth_getTransactionByHash', [ep.openTx]); opener = `${tx.from} via ${tx.to}`; } catch { /* fine */ }
    if (ep.closeTx) {
      const closeTs = await tsOf(ep.closeBlock!);
      try {
        const rc = await rpc('eth_getTransactionReceipt', [ep.closeTx]);
        const touched = new Set(rc.logs.filter((l: any) => T_ANY_SWAPS.includes(l.topics[0])).map((l: any) => l.address.toLowerCase()));
        const both = touched.has(ep.pair.up) && touched.has(ep.pair.v2);
        closer = `${(closeTs - openTs).toFixed(0)} s later by ${rc.from} via ${rc.to}: ${both ? 'ARBITRAGE (both pools in one transaction)' : `${touched.size} pool(s) touched`}, tx ${ep.closeTx}`;
      } catch { closer = `${(closeTs - openTs).toFixed(0)} s later, tx ${ep.closeTx}`; }
    }
    lines.push(
      `\n${ep.pair.sym}/USDG  max gap ${ep.maxGap.toFixed(2)}% (UP ${ep.upPrice.toPrecision(5)} vs V2 ${ep.v2Price.toPrecision(5)} USDG)`,
      `  opened ${toronto(openTs)} by a ${ep.openKind}${ep.openUsdg !== undefined ? ` of ${ep.openUsdg.toFixed(2)} USDG` : ''}, from ${opener}, tx ${ep.openTx}`,
      `  depth: V2 pool holds ${ep.v2Usdg.toFixed(0)} USDG; UP pool liquidity ${ep.upLiq ?? '?'} (raw)`,
      `  closed: ${closer}`,
      `  pools: UP ${ep.pair.up}, V2 ${ep.pair.v2}`,
    );
  }
  annotate('Big win check (UP CL vs Uniswap V2)', lines);
}

main().catch((e) => { annotate('Big win check failed', [String(e?.message ?? e)]); });
