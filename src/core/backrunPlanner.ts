import { PoolState, StateType } from './types';
import { PoolCache } from './poolCache';
import { findOptimalTradeSize, calculateAllInProfit, calculateLiquidityCeiling, CostEstimateInputs, SizingResult } from './profitCalculator';

// ============================================================================
// BACKRUN PLANNER — "guess the price before it happens"
//
// Plain English:
//   We just saw a big swap that hasn't landed yet. Instead of comparing the
//   two DEXs at TODAY's price, we apply that swap to our own copy of the
//   pool (predictPostTradeState) to get the price AFTER it lands. Then we
//   look for the arb against that future price.
//
// Why two directions:
//   The big swap makes tokenIn CHEAPER on the pool it trades through. The
//   classic backrun is: sell tokenIn on the OTHER DEX, buy it back cheap on
//   the pool that just got pushed. We test both round trips (victim->peer
//   and peer->victim) and keep whichever nets more, so a wrong guess about
//   direction can never hide a real opportunity.
// ============================================================================

export interface BackrunPlan {
  usedPrediction: boolean;          // true = priced against the predicted post-trade state
  buyPool: PoolState;               // pool where our round trip starts (tokenIn -> tokenOut)
  sellPool: PoolState;              // pool where it ends (tokenOut -> tokenIn)
  sizing: SizingResult;
  profit: ReturnType<typeof calculateAllInProfit>;
}

// States where the swap has NOT been applied to on-chain state yet, so
// predicting its effect is meaningful. FINALIZED means it already happened;
// applying it again to our cache would double-count it.
const PREDICTABLE_STATES: StateType[] = ['PENDING', 'SPECULATIVE', 'SEQUENCED'];

export function planBackrun(
  cache: PoolCache,
  victimPool: PoolState,            // pool the big pending swap trades through
  peerPool: PoolState,              // same pair on another DEX
  swap: { tokenIn: string; amountIn: bigint; stateType: StateType },
  usdPerTokenIn: number,
  costs: CostEstimateInputs,
): BackrunPlan | null {
  const tokenIn = swap.tokenIn.toLowerCase();

  // Step 1: predict the victim pool AFTER the big swap lands.
  let predictedVictim = victimPool;
  let usedPrediction = false;
  if (PREDICTABLE_STATES.includes(swap.stateType) && swap.amountIn > 0n) {
    const victimTokenInIsA = victimPool.tokenA.toLowerCase() === tokenIn;
    const predicted = cache.predictPostTradeState(victimPool, victimTokenInIsA, swap.amountIn);
    // predictPostTradeState returns the SAME object when it can't model the
    // pool (order book, stable, missing data). Only count it as a real
    // prediction when it actually produced a new state.
    if (predicted !== victimPool) {
      predictedVictim = predicted;
      usedPrediction = true;
    }
  }

  // Step 2: size + cost both round-trip directions against the predicted state.
  const evaluate = (buyPool: PoolState, sellPool: PoolState): BackrunPlan | null => {
    const ceiling = calculateLiquidityCeiling(buyPool, sellPool, usdPerTokenIn);
    if (ceiling <= 0) return null;
    const tokenInIsAOnBuy = buyPool.tokenA.toLowerCase() === tokenIn;
    const sizing = findOptimalTradeSize(buyPool, sellPool, cache, tokenInIsAOnBuy, ceiling, usdPerTokenIn);
    if (!(sizing.grossProfitUsd > 0)) return null;
    const profit = calculateAllInProfit(sizing, {
      ...costs,
      dexFeeBps: { buy: buyPool.feeBps, sell: sellPool.feeBps },
    });
    return { usedPrediction, buyPool, sellPool, sizing, profit };
  };

  const candidates = [
    evaluate(predictedVictim, peerPool), // tokenIn -> tokenOut on victim, back on peer
    evaluate(peerPool, predictedVictim), // tokenIn -> tokenOut on peer, back on victim (classic backrun)
  ].filter((c): c is BackrunPlan => c !== null);

  if (candidates.length === 0) return null;

  // Step 3: keep whichever direction nets more after all costs.
  return candidates.reduce((best, c) =>
    c.profit.conservativeNetProfitUsd > best.profit.conservativeNetProfitUsd ? c : best,
  );
}
