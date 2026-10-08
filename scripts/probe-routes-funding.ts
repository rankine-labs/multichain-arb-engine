// ============================================================================
// ROUTE + FUNDING PROBE (research, read-only, never sends anything)
//
// Plain English:
//   Reads blocks from Robinhood Chain spread over the last PROBE_HOURS hours
//   (several short windows, so busy and quiet times are both in the sample)
//   and finds every rival arbitrage trade: a transaction that swapped
//   through 2+ pools and left the bot (contract + sender) with more of some
//   coin and less of none. For each one it records the route length, how it
//   was paid for (flash loan, a pool paying first, or own money), the gain,
//   gas, trade size, and whether OUR contract could trade every pool in it.
//   The maths and the report live in src/core/routeFundingStudy.ts.
//
//   Answers Phase 6: are 3/4-pool loops worth building, and is a flash loan
//   (9 bps in today's planner) or own money the better way to pay?
//
// Settings (environment):
//   PROBE_WINDOWS   number of windows (default 6)
//   PROBE_WINDOW    blocks per window (default 1000)
//   PROBE_HOURS     spread the windows over this many hours back (default 24)
//   PROBE_BATCH     blocks per batched request (default 4)
//   PROBE_PACE_MS   pause between requests (default 800, the public node
//                   answers 403 if asked too fast)
//   PROBE_MAX_MINUTES  stop reading new windows after this (default 42)
//
// Run: npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-routes-funding.js
// ============================================================================
import { ethers } from 'ethers';
import { ROBINHOOD_SCAN_FACTORIES, ROBINHOOD_TOKENS } from '../src/config/knownAddresses';
import { StudyTrade, formatStudy } from '../src/core/routeFundingStudy';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const WETH = ROBINHOOD_TOKENS.WETH.toLowerCase();
const USDG = ROBINHOOD_TOKENS.USDG.toLowerCase();
// Deepest WETH/USDG pool (Uniswap V3 0.01%): used only to price ETH in USD.
const PRICE_POOL = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca';
const WINDOWS = Number(process.env.PROBE_WINDOWS ?? 6);
const WINDOW = Number(process.env.PROBE_WINDOW ?? 1000);
// Stop reading new windows after this long, so the report always prints
// before the workflow's time limit.
const MAX_MS = Number(process.env.PROBE_MAX_MINUTES ?? 42) * 60_000;
const HOURS = Number(process.env.PROBE_HOURS ?? 24);
const BATCH = Math.max(1, Number(process.env.PROBE_BATCH ?? 4));
const PACE_MS = Number(process.env.PROBE_PACE_MS ?? 800);

// Factories whose pools our contract can trade (V2, Solidly, V3 kinds).
const KNOWN: Record<string, string> = Object.fromEntries(ROBINHOOD_SCAN_FACTORIES.map((f) => [f.factory.toLowerCase(), f.dex]));

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const DEPOSIT = ethers.id('Deposit(address,uint256)');
const WITHDRAWAL = ethers.id('Withdrawal(address,uint256)');
const V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const SWAPS = new Set([
  ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),           // Uniswap V2 style
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),       // Uniswap V3 style
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'), // Pancake V3
  V4_SWAP,
]);
const FLASH = new Set([
  ethers.id('Flash(address,address,uint256,uint256,uint256,uint256)'),          // V3 pool flash
  ethers.id('FlashLoan(address,address,address,uint256,uint8,uint256,uint16)'), // Aave V3
  ethers.id('FlashLoan(address,address,uint256,uint256)'),
]);
const ta = (t: string) => '0x' + t.slice(26).toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// RPC with batching and polite back-off (403 / 429 = slow down).
// ---------------------------------------------------------------------------
let id = 0, blocked = 0;
async function rpcBatch(calls: { method: string; params: unknown[] }[]): Promise<any[]> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const body = calls.map((c) => ({ jsonrpc: '2.0', id: ++id, method: c.method, params: c.params }));
      const res = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 403 || res.status === 429) { blocked++; await sleep(15_000 * (attempt + 1)); continue; }
      const j = await res.json();
      if (!Array.isArray(j)) { await sleep(3_000 * (attempt + 1)); continue; }
      if (j.some((x: any) => x?.error && /429|Too Many|rate/i.test(JSON.stringify(x.error)))) { await sleep(3_000 * (attempt + 1)); continue; }
      // Answers can come back in any order: put them back in request order.
      const first = body[0]!.id;
      const out: any[] = new Array(calls.length).fill(null);
      for (const x of j) if (typeof x?.id === 'number') out[x.id - first] = x;
      return out;
    } catch { await sleep(2_000 * (attempt + 1)); }
  }
  return new Array(calls.length).fill({ error: { message: 'gave up' } });
}
const rpc = async (method: string, params: unknown[]) => (await rpcBatch([{ method, params }]))[0];
const word = (r: string | undefined | null, i = 0) => (r && r.length >= 2 + 64 * (i + 1) ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null);
const addrOf = (r: string | undefined | null) => (r && r.length >= 66 ? '0x' + r.slice(26, 66).toLowerCase() : null);

// Many eth_calls, bundled BATCH*2 per request, paced.
async function callMany(calls: { to: string; data: string }[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  const per = BATCH * 2;
  for (let i = 0; i < calls.length; i += per) {
    const part = calls.slice(i, i + per);
    const res = await rpcBatch(part.map((c) => ({ method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] })));
    for (const r of res) out.push(typeof r?.result === 'string' ? r.result : null);
    await sleep(PACE_MS);
  }
  return out;
}

function decodeSymbol(r: string | null): string {
  try {
    if (r && r.length >= 194) { const len = Number(BigInt('0x' + r.slice(66, 130))); if (len <= 64) return Buffer.from(r.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '').slice(0, 12) || '?'; }
    if (r && r.length >= 66) return Buffer.from(r.slice(2, 66), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '').slice(0, 12) || '?';
  } catch { /* fall through */ }
  return '?';
}

// Coin balance changes of the bot (contract + sender) in one receipt.
function deltasFor(logs: any[], E: Set<string>): Map<string, bigint> {
  const d = new Map<string, bigint>();
  const add = (tok: string, v: bigint) => d.set(tok, (d.get(tok) ?? 0n) + v);
  for (const l of logs) {
    const t0 = l.topics?.[0];
    const tok = String(l.address).toLowerCase();
    let v: bigint; try { v = BigInt(l.data === '0x' ? 0 : String(l.data).slice(0, 66)); } catch { continue; }
    if (t0 === TRANSFER && l.topics.length >= 3) {
      const f = ta(l.topics[1]), t = ta(l.topics[2]);
      if (E.has(f) && E.has(t)) continue;            // moved between the bot and its owner
      if (E.has(t)) add(tok, v);
      if (E.has(f)) add(tok, -v);
    } else if (tok === WETH && (t0 === DEPOSIT || t0 === WITHDRAWAL) && l.topics.length >= 2) {
      // Wrapping / unwrapping ETH: native ETH is not in the logs, so neutral.
      if (E.has(ta(l.topics[1]))) add('native-eth-wrap', 1n);
    }
  }
  return d;
}

interface Raw { block: number; from: string; to: string; pools: string[]; deltas: Map<string, bigint>; flash: boolean; paidFirst: boolean; gasWei: bigint; outs: { tok: string; v: bigint }[] }

(async () => {
  // ETH price in USD from the deep WETH/USDG pool.
  const [t0r, slot0] = await callMany([{ to: PRICE_POOL, data: '0x0dfe1681' }, { to: PRICE_POOL, data: '0x3850c7bd' }]);
  const sq = Number(word(slot0, 0) ?? 0n) / 2 ** 96;
  const wethIs0 = addrOf(t0r) === WETH;
  const raw = sq * sq; // token1 per token0, in raw units
  const ethUsd = wethIs0 ? raw * 1e12 : raw > 0 ? 1 / (raw * 1e-12) : 0;
  if (!(ethUsd > 100 && ethUsd < 100_000)) { console.log(`ETH price looks wrong ($${ethUsd}); stopping.`); return; }
  const usd = (tok: string, v: bigint) => (tok === WETH ? (Number(v) / 1e18) * ethUsd : tok === USDG ? Number(v) / 1e6 : null);

  // Blocks per second, to place the windows over the last PROBE_HOURS.
  const latest = Number((await rpc('eth_blockNumber', [])).result);
  const back = 200_000;
  const [bLatest, bBack] = await rpcBatch([
    { method: 'eth_getBlockByNumber', params: ['0x' + latest.toString(16), false] },
    { method: 'eth_getBlockByNumber', params: ['0x' + (latest - back).toString(16), false] },
  ]);
  const tsLatest = Number(bLatest?.result?.timestamp ?? 0), tsBack = Number(bBack?.result?.timestamp ?? 0);
  const bps = tsLatest > tsBack ? back / (tsLatest - tsBack) : 8;
  const span = Math.floor(HOURS * 3600 * bps);
  console.log(`ETH $${ethUsd.toFixed(2)}; latest block ${latest}; ${bps.toFixed(2)} blocks/s; span ${span} blocks`);

  const trades: Raw[] = [];
  let blocksRead = 0, txs = 0, chainSeconds = 0, windowsRead = 0;
  const startedAt = Date.now();
  for (let w = 0; w < WINDOWS; w++) {
    if (Date.now() - startedAt > MAX_MS) { console.log(`time limit: stopping after ${w} windows`); break; }
    windowsRead++;
    // Window w ends this far back (window 0 = the most recent).
    const end = latest - 5 - Math.floor((span * w) / Math.max(1, WINDOWS));
    const start = end - WINDOW + 1;
    let firstTs = 0, lastTs = 0;
    for (let n = start; n <= end; n += BATCH) {
      const nums = Array.from({ length: Math.min(BATCH, end - n + 1) }, (_, i) => n + i);
      const res = await rpcBatch(nums.map((b) => ({ method: 'eth_getBlockReceipts', params: ['0x' + b.toString(16)] })));
      await sleep(PACE_MS);
      res.forEach((r, i) => {
        const rcpts: any[] = r?.result ?? [];
        if (!Array.isArray(rcpts)) return;
        blocksRead++; txs += rcpts.length;
        for (const rc of rcpts) {
          if (rc.status !== '0x1' || !rc.to) continue;
          const pools: string[] = [];
          for (const l of rc.logs ?? []) {
            const t0 = l.topics?.[0];
            if (SWAPS.has(t0)) { const p = t0 === V4_SWAP ? String(l.topics[1]).toLowerCase() : String(l.address).toLowerCase(); if (!pools.includes(p)) pools.push(p); }
          }
          if (pools.length < 2) continue;
          const E = new Set([String(rc.to).toLowerCase(), String(rc.from).toLowerCase()]);
          const d = deltasFor(rc.logs, E);
          const moves = [...d.entries()].filter(([k, v]) => v !== 0n && k !== 'native-eth-wrap');
          if (!moves.length || moves.some(([, v]) => v < 0n)) continue; // not "ends with more, less of nothing"
          const logs = rc.logs ?? [];
          const firstIn = logs.findIndex((l: any) => l.topics?.[0] === TRANSFER && l.topics.length >= 3 && E.has(ta(l.topics[2])));
          const firstOut = logs.findIndex((l: any) => l.topics?.[0] === TRANSFER && l.topics.length >= 3 && E.has(ta(l.topics[1])));
          const outs: { tok: string; v: bigint }[] = [];
          for (const l of logs) if (l.topics?.[0] === TRANSFER && l.topics.length >= 3 && E.has(ta(l.topics[1])) && !E.has(ta(l.topics[2]))) {
            const tok = String(l.address).toLowerCase();
            if (tok === WETH || tok === USDG) { try { outs.push({ tok, v: BigInt(String(l.data).slice(0, 66)) }); } catch { /* skip */ } }
          }
          trades.push({
            block: nums[i]!, from: String(rc.from).toLowerCase(), to: String(rc.to).toLowerCase(), pools, deltas: d,
            flash: logs.some((l: any) => FLASH.has(l.topics?.[0])),
            paidFirst: firstIn >= 0 && (firstOut < 0 || firstIn < firstOut),
            gasWei: BigInt(rc.gasUsed ?? '0x0') * BigInt(rc.effectiveGasPrice ?? '0x0'), outs,
          });
        }
      });
    }
    // Chain time covered by this window.
    const [bs, be] = await rpcBatch([
      { method: 'eth_getBlockByNumber', params: ['0x' + start.toString(16), false] },
      { method: 'eth_getBlockByNumber', params: ['0x' + end.toString(16), false] },
    ]);
    firstTs = Number(bs?.result?.timestamp ?? 0); lastTs = Number(be?.result?.timestamp ?? 0);
    if (lastTs > firstTs) chainSeconds += lastTs - firstTs;
    console.log(`window ${w + 1}/${WINDOWS}: blocks ${start}-${end} (${new Date(firstTs * 1000).toISOString().slice(0, 16)} UTC), arbs so far ${trades.length}, node blocks ${blocked}`);
  }

  // Pool details (factory, coins) for every non-V4 pool seen, read once.
  const pools = [...new Set(trades.flatMap((t) => t.pools).filter((p) => p.length === 42))];
  const meta = await callMany(pools.flatMap((p) => [{ to: p, data: '0xc45a0155' }, { to: p, data: '0x0dfe1681' }, { to: p, data: '0xd21220a7' }]));
  const info = new Map<string, { dex: string; known: boolean; t0: string | null; t1: string | null }>();
  pools.forEach((p, i) => {
    const fac = addrOf(meta[i * 3]);
    const dex = fac && KNOWN[fac] ? KNOWN[fac]! : `other(${(fac ?? '?').slice(0, 8)})`;
    info.set(p, { dex, known: !!(fac && KNOWN[fac]), t0: addrOf(meta[i * 3 + 1]), t1: addrOf(meta[i * 3 + 2]) });
  });
  const toks = [...new Set([...info.values()].flatMap((x) => [x.t0, x.t1]).filter((x): x is string => !!x))];
  const symRes = await callMany(toks.map((t) => ({ to: t, data: '0x95d89b41' })));
  const sym = new Map(toks.map((t, i) => [t, t === WETH ? 'WETH' : t === USDG ? 'USDG' : decodeSymbol(symRes[i] ?? null)]));
  const label = (p: string) => {
    if (p.length !== 42) return 'V4';
    const x = info.get(p)!;
    return `${x.dex} ${sym.get(x.t0 ?? '') ?? '?'}/${sym.get(x.t1 ?? '') ?? '?'}`;
  };

  // Turn raw trades into study rows.
  const rows: StudyTrade[] = trades.map((t) => {
    const moves = [...t.deltas.entries()].filter(([k, v]) => v > 0n && k !== 'native-eth-wrap');
    const verified = moves.every(([k]) => k === WETH || k === USDG);
    const grossUsd = verified ? moves.reduce((s, [k, v]) => s + (usd(k, v) ?? 0), 0) : 0;
    const gasUsd = (Number(t.gasWei) / 1e18) * ethUsd;
    let sizeUsd = 0, sizeToken: 'USDG' | 'WETH' | null = null;
    for (const o of t.outs) { const u = usd(o.tok, o.v) ?? 0; if (u > sizeUsd) { sizeUsd = u; sizeToken = o.tok === WETH ? 'WETH' : 'USDG'; } }
    const gainSet = new Set(moves.map(([k]) => k));
    const gainToken = !verified ? 'other' : gainSet.size > 1 ? 'both' : gainSet.has(WETH) ? 'WETH' : 'USDG';
    const unknownFactory = t.pools.some((p) => p.length === 42 && !info.get(p)?.known);
    return {
      block: t.block, bot: t.to, pools: t.pools.length, flashLoan: t.flash, poolPaidFirst: t.paidFirst, verified,
      gainToken, grossUsd, gasUsd, sizeUsd, sizeToken, executable: !unknownFactory, unknownFactory,
      shape: t.pools.map(label).join(' > '),
    } as StudyTrade;
  });

  const report = formatStudy(rows, { blocks: blocksRead, txs, chainMinutes: chainSeconds / 60, windows: windowsRead });
  console.log(`node 403/429 back-offs: ${blocked}`);
  console.log(report);
  // One GitHub annotation per ~30 lines (the workflow step also wraps the tail).
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
  const ls = report.split('\n');
  for (let i = 0; i < ls.length; i += 30) console.log(`::notice title=Routes and funding ${i / 30 + 1}::${esc(ls.slice(i, i + 30).join('\n'))}`);
})();
