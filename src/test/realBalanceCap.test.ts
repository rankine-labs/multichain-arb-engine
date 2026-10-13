import { findStandingGaps, capToRealBalance } from '../core/gapScanner';
import { deepEnough, poolDepthUsd, setRealBalanceSource, thinPools, realBalanceOf } from '../core/poolPrice';
import { PoolState } from '../core/types';

// Real balance cap (Oct 13, the USDG/NVDA problem): a V3 pool whose liquidity
// sits in one tiny price band looks deep from its price maths but holds
// almost nothing. Numbers below are the real ones read from the chain on
// Oct 13 (probe-nvda): the Uniswap V3 0.01% pool said NVDA = $207 with ~$400k
// of "virtual" depth but held $83 of USDG and 0.003 NVDA; the 0.05% pool said
// $225 and really held $1.2M. The bot saw a ~$300 "gap" between them and
// every practice check broke. With real balances known, that gap is gone.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'; // 6 decimals, token0
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'; // 18 decimals, token1
const THIN = '0xb75d2d02b0ec3de50d32e40a4f1a8dae8acc4333'; // Uniswap V3 0.01%
const DEEP = '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3'; // Uniswap V3 0.05%

// sqrtPriceX96 for "1 NVDA = usdPerNvda USDG" with USDG as token0:
// price = NVDA raw units per USDG raw unit = (1 / usdPerNvda) * 1e18 / 1e6.
const sqrtX96 = (usdPerNvda: number) => BigInt(Math.floor(Math.sqrt((1 / usdPerNvda) * 1e12) * 2 ** 96));
const v3 = (addr: string, usdPerNvda: number, L: bigint, feeBps: number): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v3', poolAddress: addr, poolType: 'v3', tokenA: USDG, tokenB: NVDA,
  sqrtPriceX96: sqrtX96(usdPerNvda), liquidity: L, feeBps, feePips: feeBps * 100, lastUpdatedBlock: 0, lastUpdatedMs: 0,
});
const thin = v3(THIN, 207.19, 14297015922504961n, 1);
const deep = v3(DEEP, 225.37, 5771655158580063189n, 5);

const dec = (t: string) => (t.toLowerCase() === NVDA ? 18 : t.toLowerCase() === USDG ? 6 : undefined);
const decOf = (_c: string, t: string) => dec(t) ?? 18;
const usd = (t: string) => (t.toLowerCase() === USDG ? 1 : t.toLowerCase() === NVDA ? 225 : null);
const opts = { minProfitUsd: 0.1, flashFee: 0, gasUsd: 0.05, maxTradeUsd: 20_000, perPair: 3 };

// Real balances as read on Oct 13.
const balances = new Map<string, bigint>([
  [`${THIN}:${USDG}`, 82_916_605n],                       // $82.92
  [`${THIN}:${NVDA}`, 2_978_673_301_916_364n],            // 0.00298 NVDA
  [`${DEEP}:${USDG}`, 1_223_335_314_419n],                // $1.22M
  [`${DEEP}:${NVDA}`, 6_412_121_117_627_669_000_000n],    // 6,412 NVDA
]);
const source = (pool: string, token: string) => balances.get(`${pool.toLowerCase()}:${token.toLowerCase()}`);

// 1) Without real balances (the old behaviour): the fake gap shows up.
setRealBalanceSource(null);
const before = findStandingGaps([[thin, deep]], dec, usd, opts);
assert(before.length > 0 && before[0].profitUsd > 100, `old maths: fake gap of $${before[0]?.profitUsd.toFixed(0)} against the thin pool`);
assert(deepEnough(thin, decOf, usd), 'old maths: thin pool looks deep ($10k+)');

// 2) With real balances: the thin pool is not deep, and the gap is gone.
setRealBalanceSource(source);
assert(!deepEnough(thin, decOf, usd), `thin pool left out (real depth $${poolDepthUsd(thin, decOf, usd)!.toFixed(0)})`);
assert(deepEnough(deep, decOf, usd), 'the genuinely deep pool still counts');
const after = findStandingGaps([[thin, deep]], dec, usd, opts);
const best = after.reduce((m, g) => Math.max(m, g.profitUsd), 0);
assert(best < 1, `gap against the thin pool shrinks to $${best.toFixed(2)} (was $${before[0]?.profitUsd.toFixed(0)})`);
assert(after.every((g) => g.sizeUsd < 200), 'any trade left is sized to what the thin pool can really pay');

// 3) The status-page list names exactly the thin pool.
const t = thinPools([thin, deep], decOf, usd);
assert(t.length === 1 && t[0].pool.poolAddress === THIN && t[0].realUsd < 200 && t[0].virtualUsd > 10_000, 'thin pool listed with real vs assumed depth');

// 4) The cap keeps the price, only depth shrinks; unknown balances change nothing.
const r = { base: 1000, quote: 225_000 };
const c = capToRealBalance(r, thin, USDG, 'quote', 6)!;
assert(Math.abs(c.quote / c.base - 225) < 1e-9 && c.quote <= 82.92 + 1e-6, 'capped reserves keep the price, paid-out side fits the real balance');
const unknownPool = { ...thin, poolAddress: '0x' + '99'.repeat(20) };
assert(capToRealBalance(r, unknownPool, USDG, 'quote', 6) === r, 'balance not read yet -> unchanged (as before)');
assert(capToRealBalance(r, { ...thin, poolAddress: '0x' + '98'.repeat(20) }, USDG, 'quote', 6) === r, 'other unknown pool -> unchanged');
balances.set(`${'0x' + '97'.repeat(20)}:${USDG}`, 0n);
assert(capToRealBalance(r, { ...thin, poolAddress: '0x' + '97'.repeat(20) }, USDG, 'quote', 6) === null, 'pool holding none of the paid-out coin -> no pool');

// 5) V4 and V2 pools are never capped (no per-pool balance to read).
const v4: PoolState = { ...thin, poolAddress: '0x' + 'ab'.repeat(32), v4: { fee: 100, tickSpacing: 1, native: false, poolManager: '0x' + '01'.repeat(20), stateView: '0x' + '02'.repeat(20) } };
assert(realBalanceOf(v4, USDG) === undefined, 'V4 pool: not capped');
const v2: PoolState = { ...thin, poolType: 'v2', reserveA: 1n, reserveB: 1n };
assert(realBalanceOf(v2, USDG) === undefined, 'V2 pool: not capped (its reserves are already real)');

setRealBalanceSource(null); // leave no global state behind
