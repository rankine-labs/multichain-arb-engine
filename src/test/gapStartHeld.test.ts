// Gap scanner: gaps on a pair that contains a coin we hold (USDG / WETH) are
// always traded STARTING from that coin (Oct 16, owner approved).
//
// The case that started it: on USDG/ORBIO, USDG's address sorts first
// (token0), so the old rule ("start from token1 when it has a price") started
// from ORBIO. Practice counted the win, but live can't send it: we hold no
// ORBIO. Same two pools, same gap, the other order: start with USDG, buy
// ORBIO where it is cheap, sell it where it is dear, end with more USDG.
import { findStandingGaps, findStandingGapsSteps, GapScanMemo, pickQuote, GapOptions } from '../core/gapScanner';
import { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
function drain<T>(g: Generator<void, T, void>): T { for (;;) { const r = g.next(); if (r.done) return r.value; } }

// Addresses chosen so USDG sorts BEFORE the meme coin (USDG = token0).
const USDG = '0x1000000000000000000000000000000000000001';
const ORBIO = '0x2000000000000000000000000000000000000002';
const WETH = '0x0100000000000000000000000000000000000003';
const NVDA = '0x3000000000000000000000000000000000000004';
const SPY = '0x4000000000000000000000000000000000000005';

// A V2 pool with token0 = a, token1 = b and human reserves ra / rb (18 decimals both, for simplicity).
const v2 = (addr: string, a: string, b: string, ra: number, rb: number): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v2', poolAddress: addr, poolType: 'v2', tokenA: a, tokenB: b,
  reserveA: BigInt(Math.round(ra * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rb * 1e6)) * 10n ** 12n,
  feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: 0,
});

const dec = () => 18;
const usd = new Map<string, number>([[USDG, 1], [ORBIO, 1], [WETH, 3000], [NVDA, 180], [SPY, 600]]);
const usdOf = (t: string) => usd.get(t.toLowerCase()) ?? null;
const held = [USDG, WETH];

// 1) pickQuote rules.
{
  assert(pickQuote(USDG, ORBIO, usdOf, held)?.quote === USDG, 'USDG/ORBIO with held coins: start from USDG (token0)');
  assert(pickQuote(USDG, ORBIO, usdOf)?.quote === ORBIO, 'USDG/ORBIO without held coins: old rule starts from ORBIO (token1), the bug');
  assert(pickQuote(ORBIO, WETH, usdOf, held)?.quote === WETH, 'ORBIO/WETH: start from WETH');
  assert(pickQuote(WETH, ORBIO, usdOf, held)?.quote === WETH, 'WETH/ORBIO (WETH token0): start from WETH');
  assert(pickQuote(WETH, USDG, usdOf, held)?.quote === USDG, 'WETH/USDG (both held): old rule decides (token1)');
  assert(pickQuote(NVDA, SPY, usdOf, held)?.quote === SPY, 'NVDA/SPY (neither held): old rule, unchanged');
  const noPrice = (t: string) => (t === USDG ? null : usdOf(t));
  assert(pickQuote(USDG, ORBIO, noPrice, held)?.quote === ORBIO, 'held coin without a USD price is not forced (falls back)');
  assert(pickQuote(USDG, ORBIO, () => null, held) === null, 'no prices at all: no gap');
}

// 2) Real scan: USDG/ORBIO, ORBIO cheap on pool A ($1.00) and dear on pool B ($1.05).
{
  const A = v2('0xa000000000000000000000000000000000000001', USDG, ORBIO, 100_000, 100_000);        // 1 ORBIO = 1.00 USDG
  const B = v2('0xb000000000000000000000000000000000000002', USDG, ORBIO, 105_000, 100_000);        // 1 ORBIO = 1.05 USDG
  const base: GapOptions = { minProfitUsd: 0.1, flashFee: 0, gasUsd: 0.02, maxTradeUsd: 2_000, perPair: 1 };
  const oldWay = findStandingGaps([[A, B]], dec, usdOf, base);
  const newWay = findStandingGaps([[A, B]], dec, usdOf, { ...base, startCoins: held });
  assert(oldWay.length === 1 && oldWay[0].quote === ORBIO, 'old rule: the gap is found but starts from ORBIO (live can\'t send)');
  assert(newWay.length === 1 && newWay[0].quote === USDG && newWay[0].base === ORBIO, 'new rule: the same gap starts and ends in USDG');
  const g = newWay[0];
  assert(g.buyPool.poolAddress === A.poolAddress && g.sellPool.poolAddress === B.poolAddress, 'buys ORBIO where it is cheap (A), sells where it is dear (B)');
  assert(g.profitUsd > 0.1 && g.sizeUsd <= 2_000, `profit in USDG after fees and gas ($${g.profitUsd.toFixed(2)} on $${g.sizeUsd.toFixed(0)})`);
  // Same gap, either side: the dollar profit is in the same range.
  const ratio = g.profitUsd / oldWay[0].profitUsd;
  assert(ratio > 0.5 && ratio < 2, `same gap from the USDG side is worth about the same (${(ratio * 100).toFixed(0)}% of the ORBIO-side estimate)`);

  // Fast (memo) scan gives the same answer, and switching the rule on resets the memo.
  const memo = new GapScanMemo();
  const fastOld = drain(findStandingGapsSteps([[A, B]], dec, usdOf, base, memo));
  const fastNew = drain(findStandingGapsSteps([[A, B]], dec, usdOf, { ...base, startCoins: held }, memo));
  assert(fastOld[0].quote === ORBIO && fastNew[0].quote === USDG, 'fast scan follows the rule too (memo not stuck on the old side)');
  assert(fastNew[0].profitUsd === g.profitUsd && fastNew[0].sizeQuote === g.sizeQuote, 'fast scan == one-go scan with the new rule');
}

// 3) Pairs without a held coin are untouched.
{
  const P = v2('0xc000000000000000000000000000000000000003', NVDA, SPY, 1_000, 300);
  const Q = v2('0xd000000000000000000000000000000000000004', NVDA, SPY, 1_000, 315);
  const opts: GapOptions = { minProfitUsd: 0.1, flashFee: 0, gasUsd: 0.02, maxTradeUsd: 2_000, perPair: 1 };
  const a = findStandingGaps([[P, Q]], dec, usdOf, opts);
  const b = findStandingGaps([[P, Q]], dec, usdOf, { ...opts, startCoins: held });
  assert(a.length === b.length && (a.length === 0 || (a[0].quote === b[0].quote && a[0].profitUsd === b[0].profitUsd)), 'NVDA/SPY: same result with or without the rule');
}
