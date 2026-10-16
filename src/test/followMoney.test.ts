import { ethers } from 'ethers';
import {
  FTM_TOPICS, decodeSwapLog, classifyTx, receiptGasWei, obsFromSwap, buildPriceBook, priceArb, timingOf, buildReport,
  sizeBucket, profitBucket, RawLog, SwapRow, PriceCtx, ArbRecord, PricedArb,
} from '../core/followMoney';

// ============================================================================
// Follow the money (read-only arbitrage study): classification, pricing,
// timing and the report, all on made-up logs. No network.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const close = (a: number | null, b: number, eps = 1e-6) => a !== null && Math.abs(a - b) < eps;

const BOT = '0x00000000000000000000000000000000000000b0';
const OWNER = '0x00000000000000000000000000000000000000e0';
const USER = '0x00000000000000000000000000000000000000a1';
const ROUTER = '0x00000000000000000000000000000000000000c1';
const COLD = '0x00000000000000000000000000000000000000c0';
const LENDER = '0x00000000000000000000000000000000000000f1';
const FWD = '0x00000000000000000000000000000000000000f2';
const HUB = '0x00000000000000000000000000000000000000f3';
const POOL_A = '0x000000000000000000000000000000000000aaaa';
const POOL_B = '0x000000000000000000000000000000000000bbbb';
const POOL_C = '0x000000000000000000000000000000000000cccc';
const PM = '0x00000000000000000000000000000000000000dd';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TOK = '0x00000000000000000000000000000000000077aa';
const V4_ID = '0x' + '44'.repeat(32);

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const DEPOSIT = ethers.id('Deposit(address,uint256)');
const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const u = (v: bigint) => BigInt.asUintN(256, v).toString(16).padStart(64, '0');
const data = (...vs: bigint[]) => '0x' + vs.map(u).join('');
const transfer = (token: string, from: string, to: string, v: bigint): RawLog => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: data(v) });
const v2Swap = (pool: string, i0: bigint, i1: bigint, o0: bigint, o1: bigint): RawLog => ({ address: pool, topics: [FTM_TOPICS.V2_SWAP, pad(ROUTER), pad(ROUTER)], data: data(i0, i1, o0, o1) });
const v3Swap = (pool: string, a0: bigint, a1: bigint): RawLog => ({ address: pool, topics: [FTM_TOPICS.V3_SWAP, pad(ROUTER), pad(ROUTER)], data: data(a0, a1, 1n, 1n, 0n) });
// V4 amounts are from the swapper's side.
const v4Swap = (id: string, sender: string, a0: bigint, a1: bigint): RawLog => ({ address: PM, topics: [FTM_TOPICS.V4_SWAP, id, pad(sender)], data: data(a0, a1, 1n, 1n, 0n, 3000n) });
const meta = { hash: '0xh', block: 100, txIndex: 3, gasWei: 10n ** 13n };
const opts = { poolManager: PM, weth: WETH };
const E18 = 10n ** 18n, E6 = 10n ** 6n;

// --- decoding swap events ---------------------------------------------------
{
  const s = decodeSwapLog(v2Swap(POOL_A, 1000n, 0n, 0n, 5n));
  assert(s?.kind === 'v2' && s.a0 === 1000n && s.a1 === -5n, 'V2 swap: pool side amounts (in - out)');
  const t = decodeSwapLog(v3Swap(POOL_B, -7n, 9n));
  assert(t?.kind === 'v3' && t.a0 === -7n && t.a1 === 9n, 'V3 swap: signed amounts read as is');
  const v = decodeSwapLog(v4Swap(V4_ID, BOT, 5n, -9n));
  assert(v?.kind === 'v4' && v.pool === V4_ID && v.a0 === -5n && v.a1 === 9n && v.sender === BOT, 'V4 swap: pool id, sender, amounts flipped to the pool side');
  const packedIn = (3n << 128n) | 100n, packedOut = (50n << 128n) | 0n;
  const lb = decodeSwapLog({ address: POOL_C, topics: [FTM_TOPICS.LB_SWAP, pad(ROUTER), pad(ROUTER)], data: data(1n, packedIn, packedOut, 0n, 0n, 0n) });
  assert(lb?.kind === 'lb' && lb.a0 === 100n && lb.a1 === 3n - 50n, 'Liquidity Book swap: packed X (low) and Y (high) amounts');
  assert(decodeSwapLog(transfer(USDG, BOT, USER, 1n)) === null, 'a Transfer is not a swap');
  const sol = decodeSwapLog({ address: POOL_A, topics: [FTM_TOPICS.SOLIDLY_SWAP, pad(ROUTER), pad(ROUTER)], data: data(0n, 4n, 2n, 0n) });
  assert(sol?.kind === 'solidly' && sol.a0 === -2n && sol.a1 === 4n, 'Solidly swap decoded like V2');
}

// --- a plain 2-pool arbitrage -------------------------------------------------
// BOT: 1000 USDG -> pool A (V2) -> 0.5 WETH -> pool B (V3) -> 1010 USDG back.
const arbLogs: RawLog[] = [
  transfer(USDG, BOT, POOL_A, 1000n * E6),
  transfer(WETH, POOL_A, POOL_B, E18 / 2n),
  v2Swap(POOL_A, 0n, 1000n * E6, E18 / 2n, 0n), // token0 = WETH, token1 = USDG
  transfer(USDG, POOL_B, BOT, 1010n * E6),
  v3Swap(POOL_B, -1010n * E6, E18 / 2n),         // token0 = USDG, token1 = WETH
];
{
  const r = classifyTx(arbLogs, OWNER, BOT, '0x1', meta, opts);
  assert(r.reason === 'arb' && !!r.arb, '2-pool round trip with a gain is an arbitrage');
  const a = r.arb!;
  assert(a.pools.length === 2 && a.pools[0] === POOL_A && a.pools[1] === POOL_B, 'pools kept in route order');
  assert(a.net.length === 1 && a.net[0][0] === USDG && a.net[0][1] === (10n * E6).toString(), 'net gain = +10 USDG');
  assert(a.hops[0].tin === USDG && a.hops[0].tout === WETH && a.hops[1].tin === WETH && a.hops[1].tout === USDG, 'hops: USDG > WETH > USDG');
  assert(!a.flash && !a.sentElsewhere && a.executor === BOT && a.executorIsTo, 'own money, profit kept, executor = tx.to');
  assert(classifyTx(arbLogs, OWNER, BOT, '0x0', meta, opts).reason === 'failed', 'a reverted transaction is never an arbitrage');
}

// --- a normal user trade through a router -------------------------------------
{
  const logs: RawLog[] = [
    transfer(USDG, USER, POOL_A, 100n * E6), transfer(WETH, POOL_A, POOL_B, E18 / 20n), v2Swap(POOL_A, 0n, 100n * E6, E18 / 20n, 0n),
    transfer(TOK, POOL_B, USER, 777n), v3Swap(POOL_B, E18 / 20n, -777n),
  ];
  assert(classifyTx(logs, USER, ROUTER, '0x1', meta, opts).reason === 'user-swap', 'user pays USDG and gets another coin: a normal trade, not arbitrage');
  assert(classifyTx(logs.slice(0, 3), USER, ROUTER, '0x1', meta, opts).reason === 'one-pool', 'one pool only: not checked as arbitrage');
}

// --- profit sent to a third wallet --------------------------------------------
{
  const logs = [...arbLogs, transfer(USDG, BOT, COLD, 10n * E6)];
  const r = classifyTx(logs, OWNER, BOT, '0x1', meta, opts);
  assert(r.reason === 'arb' && !!r.arb?.sentElsewhere && r.arb.externals.includes(COLD), 'profit swept to a cold wallet still counts, marked "sent elsewhere"');
  assert(r.arb?.net[0][1] === (10n * E6).toString(), 'the swept amount is the profit');
}

// --- flash loan by borrow-then-repay -------------------------------------------
{
  const logs = [transfer(USDG, LENDER, BOT, 1000n * E6), ...arbLogs, transfer(USDG, BOT, LENDER, 1000n * E6)];
  const r = classifyTx(logs, OWNER, BOT, '0x1', meta, opts);
  assert(r.reason === 'arb' && r.arb?.flash === true && r.arb.flashHow === 'borrow-repay', 'borrowed and repaid in the same tx = flash loan');
  const flashEvt: RawLog = { address: POOL_C, topics: [ethers.id('Flash(address,address,uint256,uint256,uint256,uint256)'), pad(BOT), pad(BOT)], data: data(1n, 0n, 1n, 0n) };
  const r2 = classifyTx([flashEvt, ...arbLogs], OWNER, BOT, '0x1', meta, opts);
  assert(r2.arb?.flashHow === 'event', 'a Flash event = flash loan');
}

// --- tx.to only forwards: the hub contract does the work -----------------------
{
  const logs = arbLogs.map((l) => (l.topics[0] === TRANSFER ? { ...l, topics: l.topics.map((t) => (t === pad(BOT) ? pad(HUB) : t)) } : l));
  const r = classifyTx(logs, OWNER, FWD, '0x1', meta, opts);
  assert(r.reason === 'arb' && r.arb?.executor === HUB && r.arb.executorIsTo === false, 'forwarder: the contract moving the coins is found and used');
}

// --- Uniswap V4 pool holding plain ETH ------------------------------------------
// BOT pays 1000 USDG into the V4 pool and gets 0.5 plain ETH (no Transfer),
// wraps it, sells 0.5 WETH on pool B for 1010 USDG.
{
  const logs: RawLog[] = [
    transfer(USDG, BOT, PM, 1000n * E6),
    v4Swap(V4_ID, BOT, E18 / 2n, -1000n * E6),     // swapper gets +0.5 ETH, pays 1000 USDG
    { address: WETH, topics: [DEPOSIT, pad(BOT)], data: data(E18 / 2n) },
    transfer(WETH, BOT, POOL_B, E18 / 2n),
    transfer(USDG, POOL_B, BOT, 1010n * E6),
    v3Swap(POOL_B, -1010n * E6, E18 / 2n),
  ];
  const cur = (id: string) => (id === V4_ID ? { c0: '0x0000000000000000000000000000000000000000', c1: USDG } : null);
  const r = classifyTx(logs, OWNER, BOT, '0x1', meta, { ...opts, v4Currencies: cur });
  assert(r.reason === 'arb' && r.arb?.net.length === 1 && r.arb.net[0][0] === USDG, 'V4 plain-ETH leg added from the Swap event: arbitrage, +10 USDG');
  assert(r.arb?.hops[0].tin === USDG && r.arb.hops[0].tout === WETH, 'V4 hop: USDG in, ETH (as WETH) out');
  const r2 = classifyTx(logs, OWNER, BOT, '0x1', meta, opts);
  assert(r2.reason === 'user-swap', 'without the V4 pool coins the hidden ETH leg looks like a loss (reported as unknown V4 pools)');
}

// --- gas -----------------------------------------------------------------------
{
  const g = receiptGasWei({ gasUsed: '0x10', effectiveGasPrice: '0x2', gasUsedForL1: '0x3' });
  assert(g.gasWei === 32n && g.l1GasUsed === 3n, 'Arbitrum gas: gasUsed x price (L1 part already inside)');
  assert(receiptGasWei({ gasUsed: '0x10', effectiveGasPrice: '0x2', l1Fee: '0x5' }).gasWei === 37n, 'OP-style L1 fee is added');
}

// --- prices -------------------------------------------------------------------
const stables = new Set([USDG]);
const isQuote = (t: string) => t === USDG || t === WETH;
const obs = [
  // WETH/USDG swaps: 2000, 2010, 1990 dollars per ETH
  ...obsFromSwap(90, POOL_B, USDG, WETH, -2000n * E6, E18, 6, 18, isQuote),
  ...obsFromSwap(100, POOL_B, USDG, WETH, 2010n * E6, -E18, 6, 18, isQuote),
  ...obsFromSwap(110, POOL_B, USDG, WETH, -1990n * E6, E18, 6, 18, isQuote),
  // TOK vs WETH: 1000 TOK (18 dec) for 0.01 ETH -> 0.00001 ETH each = $0.02
  ...obsFromSwap(100, POOL_C, TOK, WETH, 1000n * E18, -(E18 / 100n), 18, 18, isQuote),
];
{
  const book = buildPriceBook(obs, stables, WETH);
  assert(close(book.ethAt(100), 2000), 'ETH price = median of nearby USDG/WETH swaps');
  assert(close(book.usdAt(USDG, 5)!.usd, 1), 'dollar coin = $1');
  assert(close(book.usdAt(TOK, 100)!.usd, 0.02, 1e-9), 'other coin priced through WETH');
  assert(book.usdAt('0x0000000000000000000000000000000000000999', 100) === null, 'never-traded coin has no price');
  assert(obsFromSwap(1, POOL_B, USDG, WETH, 5n, 5n, 6, 18, isQuote).length === 0, 'both sides positive is not a clean swap (ignored)');
  const fb = buildPriceBook([], stables, WETH, { ethFallbackUsd: 3000 });
  assert(close(fb.ethAt(1), 3000), 'ETH fallback price used when no swaps are seen');
}

// --- one arbitrage in dollars ---------------------------------------------------
const decs: Record<string, number> = { [USDG]: 6, [WETH]: 18, [TOK]: 18 };
const ctxFor = (watched: Set<string>): PriceCtx => ({
  book: buildPriceBook(obs, stables, WETH), decimals: (t) => decs[t] ?? null,
  symbol: (t) => (t === USDG ? 'USDG' : t === WETH ? 'WETH' : 'TOK'), dexOf: (p) => (p === POOL_A ? 'uniswap-v2' : 'alandale'),
  isWatched: (p) => watched.has(p), botCanTrade: (d) => d === 'uniswap-v2', timeOf: (b) => b * 1000, timing: () => 'standalone',
});
{
  const a = classifyTx(arbLogs, OWNER, BOT, '0x1', meta, opts).arb!;
  const pa = priceArb(a, ctxFor(new Set([POOL_A])));
  assert(close(pa.grossUsd, 10) && close(pa.sizeUsd, 1000), 'profit $10 on a $1,000 trade');
  assert(close(pa.gasUsd, 0.00001 * 2000) && close(pa.netUsd, 10 - 0.02), 'gas valued at the ETH price; net = profit - gas');
  assert(pa.trust === 'ok' && pa.path === 'USDG > WETH > USDG' && pa.profitToken === 'USDG', 'trusted, route and profit coin named');
  assert(pa.watched === 'some' && pa.unwatchedPools[0] === POOL_B && !pa.supportedAll, 'pool B not watched, its exchange not tradeable by our bot');
  // Same trade but 100 USDG profit on $1,000: too good to be true.
  const big: ArbRecord = { ...a, net: [[USDG, (100n * E6).toString()]] };
  assert(priceArb(big, ctxFor(new Set())).trust === 'doubtful', 'profit over 5% of size is doubtful (left out of totals)');
  const unp: ArbRecord = { ...a, net: [['0x0000000000000000000000000000000000000999', '5']], hops: [] };
  assert(priceArb(unp, ctxFor(new Set())).trust === 'unpriced', 'a gain in a coin with no price is "unpriced"');
}

// --- timing ---------------------------------------------------------------------
{
  // rows: [block, txIndex, pool index, kind, a0, a1]; pool 0 = POOL_A
  const rows: SwapRow[] = [
    [99, 1, 1, 0, '1', '-1'],
    [100, 1, 0, 0, '5000', '-5000'],  // big swap on pool A before our tx
    [100, 3, 0, 0, '1', '-1'],        // our arbitrage itself
  ];
  const idx = (p: string) => (p === POOL_A ? 0 : p === POOL_B ? 1 : undefined);
  const usd = (r: SwapRow) => Number(r[4]);
  const rec = { block: 100, txIndex: 3, pools: [POOL_A, POOL_B] };
  assert(timingOf(rec, rows, idx, usd, 1000) === 'backrun-big', 'after a big swap on the same pool, same block = backrun');
  assert(timingOf(rec, rows, idx, () => 10, 1000) === 'backrun-small', 'after a small swap = backrun (small)');
  assert(timingOf({ block: 100, txIndex: 1, pools: [POOL_B] }, rows, idx, usd, 1000) === 'prev-block', 'swap on the pool one block earlier');
  assert(timingOf({ block: 100, txIndex: 0, pools: [POOL_C] }, rows, idx, usd, 1000) === 'standalone', 'nothing before it = standalone');
}

// --- buckets and the report -------------------------------------------------------
{
  assert(sizeBucket(499) === 'under $500' && sizeBucket(500) === '$500-2k' && sizeBucket(4999) === '$2k-5k' && sizeBucket(5000) === '$5k+', 'size buckets');
  assert(profitBucket(-1) === 'lost money' && profitBucket(0.5) === 'under $1' && profitBucket(150) === '$100+', 'profit buckets');
  const a = classifyTx(arbLogs, OWNER, BOT, '0x1', meta, opts).arb!;
  const pa = priceArb(a, ctxFor(new Set([POOL_A])));
  const loop: PricedArb = { ...pa, rec: { ...a, hash: '0xh2', pools: [POOL_A, POOL_B, POOL_C], executor: HUB }, netUsd: 30, grossUsd: 30.02 };
  const rep = buildReport({
    dateLabel: '2026-10-16', fromBlock: 1, toBlock: 1000, fromMs: 0, toMs: 6 * 3_600_000,
    swaps: 50, swapTxs: 40, multiSwapTxs: 5, multiPoolTxs: 4, checked: 4, reasons: { arb: 2, 'user-swap': 2 },
    arbs: [pa, loop], pairOf: () => 'WETH/USDG', dexSupport: (d) => (d === 'uniswap-v2' ? 'trades' : 'no'),
    watchInfo: 'test', ethUsd: 2000, bigSwapUsd: 1000, notes: [],
  });
  assert(close(rep.totals.netUsd, 9.98 + 30, 1e-6) && close(rep.totals.perDayUsd, (39.98 * 24) / 6, 1e-6), 'report totals and per-day pace');
  for (const s of ['## The period', '## The money', '## Who makes the money', 'Pools we watch vs not', 'Route length', 'Exchange', 'Trade size', 'Profit per trade', 'Top 20 pools we do NOT watch', '## Timing', '## What this means']) {
    assert(rep.md.includes(s), `report has section "${s}"`);
  }
  const EM = String.fromCharCode(0x2014);
  assert(!rep.md.includes(EM) && !rep.csv.includes(EM), 'no em dashes in the report');
  assert(rep.csv.trim().split('\n').length === 3 && rep.csv.startsWith('hash,block'), 'CSV: header + one line per arbitrage');
  assert(rep.md.includes(POOL_B), 'unwatched pool listed in the top-20 table');
}
