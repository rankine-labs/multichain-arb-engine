import { bestArb, reserves, decodePoolEvent, BacktestEngine, BtPool } from '../core/backtest';

// Checks the backtest's maths and bookkeeping: optimal arb size matches a
// brute-force search, no phantom profit when prices match, V3 virtual
// reserves give the right price, event decoding, and opportunity episodes.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// ---- arb maths --------------------------------------------------------------
// Buy pool: 1 BASE = 100 QUOTE; sell pool: 1 BASE = 101 QUOTE (1% gap), deep pools.
const buy = { base: 10_000, quote: 1_000_000 };
const sell = { base: 10_000, quote: 1_010_000 };
const r = bestArb(buy, 0.0005, sell, 0.0005, 0.0005);
// brute force over sizes
const profitAt = (dx: number) => {
  const got = (buy.base * dx * 0.9995) / (buy.quote + dx * 0.9995);
  const back = (sell.quote * got * 0.9995) / (sell.base + got * 0.9995);
  return back - dx * 1.0005;
};
let bf = 0;
for (let dx = 0; dx <= 20_000; dx += 10) bf = Math.max(bf, profitAt(dx));
assert(r.profit > 0 && Math.abs(r.profit - bf) / bf < 0.001, `closed-form optimum matches brute force (${r.profit.toFixed(2)} vs ${bf.toFixed(2)})`);
assert(Math.abs(profitAt(r.dx) - r.profit) < 1e-6, 'profit formula consistent with step-by-step swaps');

assert(bestArb(buy, 0.0005, buy, 0.0005, 0.0005).profit === 0, 'same price -> no arb');
assert(bestArb(buy, 0.003, { base: 10_000, quote: 1_004_000 }, 0.003, 0.0005).profit === 0, '0.4% gap with 0.3% fees each side -> no arb');
assert(bestArb(buy, 0.0005, sell, 0.0005, 0.0005, 100).dx === 100, 'trade size cap respected');

// ---- V3 virtual reserves -----------------------------------------------------
// WETH(18)/USDG(6) pool at 3000 USDG per WETH: raw price = 3000e6/1e18
const pool: BtPool = { address: 'p', dex: 'uniswap-v3', kind: 'v3', token0: 'weth', token1: 'usdg', dec0: 18, dec1: 6, fee: 0.0005 };
const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(3000e6 / 1e18) * 2 ** 96));
const res = reserves(pool, { kind: 'v3', sqrtPriceX96, liquidity: 10n ** 15n }, 'weth')!;
assert(Math.abs(res.quote / res.base - 3000) < 0.01, `V3 virtual reserves give the pool price (${(res.quote / res.base).toFixed(2)})`);
const resFlip = reserves(pool, { kind: 'v3', sqrtPriceX96, liquidity: 10n ** 15n }, 'usdg')!;
assert(Math.abs(resFlip.base / resFlip.quote - 3000) < 0.01, 'orientation flips when base is token1');

// ---- event decoding ----------------------------------------------------------
const word = (n: bigint) => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0');
const swapData = '0x' + [word(-5n), word(7n), word(sqrtPriceX96), word(10n ** 15n), word(100n)].join('');
const t = '0x' + '11'.repeat(32);
const d = decodePoolEvent('v3', { topics: [t, t, t], data: swapData });
assert(d?.kind === 'v3' && (d as any).sqrtPriceX96 === sqrtPriceX96, 'V3 Swap decoded (price + liquidity)');
assert(decodePoolEvent('v3', { topics: [t, t, t], data: swapData + word(1n) + word(2n) }) !== null, 'PancakeSwap V3 Swap (7 words) decoded');
assert(decodePoolEvent('v3', { topics: [t, t, t, t], data: swapData }) === null, 'Mint/Burn (4 topics) ignored');
assert(decodePoolEvent('v3', { topics: [t, t, t], data: '0x' + [word(1n), word(2n), word(3n), word(4n)].join('') }) === null, 'Flash (4 words) ignored');
const sync = decodePoolEvent('v2', { topics: [t], data: '0x' + word(123n) + word(456n) });
assert(sync?.kind === 'v2' && (sync as any).r0 === 123n && (sync as any).r1 === 456n, 'V2 Sync decoded');
assert(decodePoolEvent('v2', { topics: [t, t, t], data: '0x' + word(1n) + word(2n) }) === null, 'V2 Swap event (3 topics) ignored');

// ---- opportunity episodes ------------------------------------------------------
const A: BtPool = { address: 'a', dex: 'uniswap-v2', kind: 'v2', token0: 'tok', token1: 'usdg', dec0: 0, dec1: 0, fee: 0.003 };
const B: BtPool = { address: 'b', dex: 'ramses-v2', kind: 'v2', token0: 'tok', token1: 'usdg', dec0: 0, dec1: 0, fee: 0.002 };
const eng = new BacktestEngine([A, B], (x, y) => (x === 'usdg' || y === 'usdg' ? { quote: 'usdg', usd: 1 } : null), (s) => s.toUpperCase(),
  { minProfitUsd: 20, flashFee: 0.0005, gasUsd: 0.05, maxTradeUsd: 1e9 });
const v2 = (r0: number, r1: number) => ({ kind: 'v2' as const, r0: BigInt(r0), r1: BigInt(r1) });
eng.apply({ block: 1, logIndex: 0, pool: 'a', state: v2(100_000, 100_000) });
eng.apply({ block: 1, logIndex: 1, pool: 'b', state: v2(100_000, 100_000) });   // same price: nothing
eng.apply({ block: 5, logIndex: 0, pool: 'a', state: v2(95_000, 105_263) });     // big buy on A: ~10% gap
eng.apply({ block: 5, logIndex: 1, pool: 'a', state: v2(100_000, 100_000) });    // closed in the same block
eng.apply({ block: 9, logIndex: 0, pool: 'b', state: v2(105_000, 95_238) });     // gap the other way
eng.apply({ block: 12, logIndex: 0, pool: 'b', state: v2(100_000, 100_000) });   // closed 3 blocks later
eng.apply({ block: 20, logIndex: 0, pool: 'a', state: v2(90_000, 111_111) });    // still open at the end
eng.finish(25);
const ops = eng.opportunities;
assert(ops.length === 3, `three opportunities found (${ops.length})`);
assert(ops[0].closedSameBlock && ops[0].peakUsd > 20, 'first one closed in the same block (another bot)');
assert(!ops[1].closedSameBlock && ops[1].endBlock - ops[1].startBlock === 3, 'second lasted 3 blocks');
assert(ops[1].buyDex === 'ramses-v2' || ops[1].buyDex === 'uniswap-v2', 'buy/sell venue recorded');
assert(ops[2].stillOpen && ops[2].endBlock === 25, 'open opportunity closed at the end of the window');
