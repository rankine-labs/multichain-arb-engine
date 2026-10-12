import { PoolCache } from '../core/poolCache';
import { planBackrun } from '../core/backrunPlanner';
import { PoolState } from '../core/types';

// Proves the "guess the price before it happens" logic works:
// two pools start at the SAME price (no arb today). A big pending sell on
// pool A should create a gap that only the prediction can see.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const E18 = 10n ** 18n;
const costs = { gasPriceUsd: 2, dexFeeBps: { buy: 30, sell: 30 }, flashLoanFeeBps: 9, usingFlashLoan: true, safetyMarginPct: 0.15 };

// Identical pools: 3,400,000 USDC / 1,000 WETH ($3,400 per WETH) on both DEXs.
const victim: PoolState = {
  chain: 'avalanche', dex: 'dexA', poolAddress: '0xA', poolType: 'v2',
  tokenA: 'WETH', tokenB: 'USDC', reserveA: 1_000n * E18, reserveB: 3_400_000n * E18,
  feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
};
// Peer lists the pair in the OPPOSITE order, to prove ordering is handled.
const peer: PoolState = {
  chain: 'avalanche', dex: 'dexB', poolAddress: '0xB', poolType: 'v2',
  tokenA: 'USDC', tokenB: 'WETH', reserveA: 3_400_000n * E18, reserveB: 1_000n * E18,
  feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
};

const cache = new PoolCache();
cache.upsert(victim);
cache.upsert(peer);

// Someone is about to dump 50 WETH into pool A.
const bigSell = { tokenIn: 'WETH', amountIn: 50n * E18 };

// 1. Already-finalized trade: no prediction, pools equal -> nothing to do.
const noGuess = planBackrun(cache, victim, peer, { ...bigSell, stateType: 'FINALIZED' }, 3400, costs);
assert(noGuess === null || noGuess.profit.conservativeNetProfitUsd <= 0,
  'without the price guess, identical pools show no profitable arb');

// 2. Pending trade: prediction applied -> real gap appears.
const withGuess = planBackrun(cache, victim, peer, { ...bigSell, stateType: 'PENDING' }, 3400, costs);
assert(withGuess !== null, 'with the price guess, an opportunity is found');
assert(withGuess?.usedPrediction === true, 'plan reports that the prediction was used');
assert((withGuess?.profit.conservativeNetProfitUsd ?? 0) > 20,
  `predicted net profit clears $20 (got $${withGuess?.profit.conservativeNetProfitUsd.toFixed(2)})`);
// Classic backrun: sell WETH on the untouched DEX, buy it back cheap on the pushed pool.
assert(withGuess?.buyPool.dex === 'dexB' && withGuess?.sellPool.dex === 'dexA',
  'picks the backrun direction (start on peer, finish on the pool the big trade pushed)');

// 3. The real cached pool must not be modified by the guess.
assert(cache.get('avalanche', '0xA')?.reserveA === 1_000n * E18, 'prediction never alters the real cached pool');

// 4. Accurate costs (Oct 8): a 1 bp lender and 2-cent gas keep more profit
//    than the old flat 9 bps and $2, and sizing uses the same loan fee.
{
  const old = planBackrun(cache, victim, peer, { ...bigSell, stateType: 'PENDING' }, 3400, costs);
  const real = planBackrun(cache, victim, peer, { ...bigSell, stateType: 'PENDING' }, 3400, { ...costs, gasPriceUsd: 0.02, flashLoanFeeBps: 1 }, 18, { refineSize: true });
  assert(!!old && !!real && real.profit.conservativeNetProfitUsd > old.profit.conservativeNetProfitUsd,
    `real costs keep more (old $${old?.profit.conservativeNetProfitUsd.toFixed(2)} vs real $${real?.profit.conservativeNetProfitUsd.toFixed(2)})`);
  // The finer search may pick a SMALLER size if the 10-size grid overshot the peak.
  assert(!!old && !!real && real.sizing.grossProfitUsd >= old.sizing.grossProfitUsd,
    'finer size search never earns less before costs than the 10-size grid');
  const own = planBackrun(cache, victim, peer, { ...bigSell, stateType: 'PENDING' }, 3400, { ...costs, gasPriceUsd: 0.02, flashLoanFeeBps: 0, usingFlashLoan: false }, 18, { refineSize: true, funding: 'own-capital' });
  assert(!!own && own.profit.conservativeNetProfitUsd >= real!.profit.conservativeNetProfitUsd - 1e-9, 'no lender -> own money, no loan fee at all');
}

// Oct 11: a gap whose best size is above the trade cap is SHRUNK to the cap
// (still planned, still profitable), not planned too big and refused later.
{
  const uncapped = planBackrun(cache, victim, peer, { ...bigSell, stateType: 'PENDING' }, 3400, costs);
  const cap = 20_000;
  const capped = planBackrun(cache, victim, peer, { ...bigSell, stateType: 'PENDING' }, 3400, costs, 18, { maxTradeUsd: cap });
  assert((uncapped?.sizing.optimalTradeSizeUsd ?? 0) > cap, `test gap wants more than $20k (best size $${Math.round(uncapped?.sizing.optimalTradeSizeUsd ?? 0)})`);
  assert(capped !== null && capped.sizing.optimalTradeSizeUsd <= cap + 1e-6, 'with a $20k cap the trade is shrunk to $20k or less');
  assert((capped?.profit.conservativeNetProfitUsd ?? 0) > 0 && (capped?.profit.conservativeNetProfitUsd ?? 0) <= (uncapped?.profit.conservativeNetProfitUsd ?? 0), 'shrunk trade still makes money (less than uncapped)');
}
