// Double-count guard (core/tradeInclusion.ts, Oct 19). Reproduces the first
// live day's failures: the node read of the traded pool already had the
// followed trade in it, the planner applied the trade AGAIN, saw a gap that
// wasn't there, and every real trade failed.
import { PoolCache } from '../core/poolCache';
import { planBackrun } from '../core/backrunPlanner';
import { readIncludesTrade, midPrice } from '../core/tradeInclusion';
import { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const cache = new PoolCache();
const USDG = '0x1000000000000000000000000000000000000001';
const STOCK = '0x2000000000000000000000000000000000000002';
const Q96 = 2n ** 96n;
// A V3-style pool (USDG token0, STOCK token1) at "1 USDG = sqrtP^2 STOCK".
const v3 = (addr: string, sqrtP: bigint, L: bigint, feeBps = 30): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v3', poolAddress: addr, poolType: 'v3', tokenA: USDG, tokenB: STOCK,
  sqrtPriceX96: sqrtP, liquidity: L, feeBps, lastUpdatedBlock: 0, lastUpdatedMs: 1,
});

// Victim: a pool someone sells a lot of STOCK into (STOCK gets cheaper there).
const before = v3('0xaaaa000000000000000000000000000000000001', Q96, 10n ** 22n);
// Peer: same price as the victim before the trade (no gap at all to begin with).
const peer = v3('0xbbbb000000000000000000000000000000000002', Q96, 10n ** 22n, 5);
const theirTrade = { tokenIn: STOCK, amountIn: 2n * 10n ** 20n, stateType: 'SEQUENCED' as const };
const predict = (p: PoolState) => cache.predictPostTradeState(p, p.tokenA.toLowerCase() === theirTrade.tokenIn.toLowerCase(), theirTrade.amountIn);

// What the chain really looks like after their trade:
const after = predict(before);
assert(midPrice(after)! !== midPrice(before)!, 'their trade moves the victim price (setup check)');

// 1) Read taken BEFORE the trade landed (same state as our copy, but a new read).
{
  const readEarly = { ...before };
  const v = readIncludesTrade(before, readEarly, predict);
  assert(!v.includes && v.share === 0, 'read from before the trade: predict it (share 0)');
}

// 2) Read taken AFTER the trade landed (the first live day's case).
{
  const v = readIncludesTrade(before, after, predict);
  assert(v.includes && Math.abs((v.share ?? 0) - 1) < 1e-6, `read already has the trade: do NOT predict again (share ${v.share?.toFixed(3)})`);
}

// 3) No fresh read at all (our own copy used): nothing to double count.
assert(!readIncludesTrade(before, before, predict).includes, 'no fresh read: normal prediction');

// 4) The planner with and without the guard, on the AFTER read. The peer still
//    sits at the pre-trade price, so the TRUE gap is exactly one trade's move.
{
  const costs = { gasPriceUsd: 0.02, dexFeeBps: { buy: 30, sell: 5 }, flashLoanFeeBps: 0, usingFlashLoan: false, safetyMarginPct: 0.15 };
  const truth = planBackrun(cache, after, peer, { ...theirTrade, amountIn: 0n }, 1, costs, 18, { funding: 'own-capital', startToken: USDG, stateIncludesTrade: true });
  const doubled = planBackrun(cache, after, peer, theirTrade, 1, costs, 18, { funding: 'own-capital', startToken: USDG });
  const guarded = planBackrun(cache, after, peer, theirTrade, 1, costs, 18, { funding: 'own-capital', startToken: USDG, stateIncludesTrade: true });
  const t = truth?.sizing.grossProfitUsd ?? 0, d = doubled?.sizing.grossProfitUsd ?? 0, g = guarded?.sizing.grossProfitUsd ?? 0;
  console.log(`  gross profit: true $${t.toFixed(2)} · old code (trade counted twice) $${d.toFixed(2)} · with guard $${g.toFixed(2)}`);
  assert(d > t * 1.5, 'old code: counting the trade twice invents extra profit (the bug)');
  assert(Math.abs(g - t) < 1e-9, 'with the guard: profit = the true one');
}

// 5) Partial move (another trade in between, or rounding): over half = included, under half = not.
{
  const mid = (share: number): PoolState => {
    const pb = Number(before.sqrtPriceX96!), pa = Number(after.sqrtPriceX96!);
    return { ...before, sqrtPriceX96: BigInt(Math.round(pb * Math.pow(pa / pb, share))) };
  };
  assert(readIncludesTrade(before, mid(0.8), predict).includes, '80% of the move already there: included');
  assert(!readIncludesTrade(before, mid(0.2), predict).includes, '20% of the move: not included (still predict)');
  assert(!readIncludesTrade(before, mid(-0.5), predict).includes, 'moved the other way: not included');
}

// 6) Unpredictable or broken pools: never claims "included".
{
  const noPrice = { ...before, sqrtPriceX96: undefined } as PoolState;
  assert(!readIncludesTrade(noPrice, { ...noPrice }, predict).includes, 'no price data: not included (old behaviour)');
  assert(!readIncludesTrade(before, after, (p) => p).includes, 'pool the planner cannot predict: not included');
}

// 7) V2 pools work the same way.
{
  const v2 = (rA: bigint, rB: bigint): PoolState => ({ chain: 'robinhood', dex: 'uniswap-v2', poolAddress: '0xcccc000000000000000000000000000000000003', poolType: 'v2', tokenA: USDG, tokenB: STOCK, reserveA: rA, reserveB: rB, feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: 1 });
  const b = v2(10n ** 24n, 10n ** 24n);
  const a = predict(b);
  assert(readIncludesTrade(b, a, predict).includes && !readIncludesTrade(b, { ...b }, predict).includes, 'V2: after-read included, before-read not');
}
