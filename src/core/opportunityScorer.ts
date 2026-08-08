import { ArbOpportunity, MIN_NET_PROFIT_USD, ChainName } from './types';

// ============================================================================
// OPPORTUNITY SCORING ENGINE
//
// Profit alone isn't enough. A $500 opportunity on a hyper-competitive
// route we almost always lose can be worse than a $150 opportunity on a
// route we usually win. Version 1 uses simple, explainable rules — no ML.
//
// Score 0-100. Below the chain's SIMULATE threshold, skip without doing
// the expensive pre-arm work.
// ============================================================================

export interface CompetitionProfile {
  // Rolling win-rate on this chain/dex/pair combo, once we have shadow-mode
// history to compute it from. Defaults to a conservative neutral guess
// for routes we have no history on yet.
estimatedWinProbability: number; // 0-1
}

export interface ScoringInputs {
  conservativeNetProfitUsd: number;
stateType: 'PENDING' | 'SPECULATIVE' | 'SEQUENCED' | 'FINALIZED';
chain: ChainName;
competition?: CompetitionProfile;
}

const DEFAULT_WIN_PROBABILITY_BY_CHAIN: Record<ChainName, number> = {
// Rough starting priors reflecting relative competition density — refine
// continuously from real shadow-mode win/loss data per route.
avalanche: 0.55,
  monad: 0.65,
  robinhood: 0.7,
  };

export function scoreOpportunity(inputs: ScoringInputs): number {
  if (inputs.conservativeNetProfitUsd < MIN_NET_PROFIT_USD) return 0;

// Profit component: scales up to a soft ceiling, no reason to over-weight
// one huge outlier trade over consistent smaller wins.
const profitScore = Math.min(50, (inputs.conservativeNetProfitUsd / 100) * 50);

// Confidence component: speculative/sequenced-but-unconfirmed data is
// inherently less certain than finalized state.
const stateConfidence: Record<ScoringInputs['stateType'], number> = {
FINALIZED: 25,
PENDING: 20,
SEQUENCED: 20, // Robinhood: sequencer decision is authoritative, high confidence
SPECULATIVE: 12, // Monad: real chance of reorder before finalization
};
const confidenceScore = stateConfidence[inputs.stateType];

// Competition component: estimated chance we actually win the race.
const winProb = inputs.competition?.estimatedWinProbability
?? DEFAULT_WIN_PROBABILITY_BY_CHAIN[inputs.chain];
const competitionScore = winProb * 25;

return Math.round(profitScore + confidenceScore + competitionScore);
}

// Below this, we don't bother pre-arming — the expected value doesn't
// justify tying up the hot path.
export const SIMULATE_THRESHOLD = 40;

export function shouldPreArm(score: number): boolean {
return score >= SIMULATE_THRESHOLD;
}
