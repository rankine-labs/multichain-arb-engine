import { ArbOpportunity, ChainName } from './types';

// ============================================================================
// SHADOW MODE LOGGER
// This is the whole point of Phase 1. We never send a real transaction here.
// We record what we saw, what we decided, how long it took us, and — by
// watching the chain afterward — whether we would have won or lost the race.
//
// This answers the 4 Phase 1 success criteria:
//   1. Detection — did we see it at all?
//   2. Accuracy  — was our profit math right?
//   3. Speed     — would we have landed before someone else?
//   4. Diagnosis — if we lost, was it because we were slow, or outgunned?
// ============================================================================

export type ShadowOutcome =
| 'WOULD_HAVE_WON'
| 'WOULD_HAVE_LOST'
| 'SKIPPED_BELOW_MIN_PROFIT'
| 'SKIPPED_LOW_SCORE'
| 'REVERTED_IN_SIMULATION'
| 'UNRESOLVED'; // haven't checked the chain yet to know the outcome

export interface ShadowRecord {
opportunity: ArbOpportunity;
outcome: ShadowOutcome;
ourHypotheticalReactionMs?: number;   // time from trigger to "would have submitted"
competitorLandedAtMs?: number;        // filled in after we check the chain
competitorTxHash?: string;
notes?: string;
}

export class ShadowLogger {
private records: ShadowRecord[] = [];

record(entry: ShadowRecord) {
this.records.push(entry);
}

// Call this after checking the actual chain state post-opportunity
resolve(opportunityId: string, outcome: ShadowOutcome, competitorLandedAtMs?: number, competitorTxHash?: string) {
const rec = this.records.find(r => r.opportunity.id === opportunityId);
if (!rec) return;
rec.outcome = outcome;
if (competitorLandedAtMs !== undefined) rec.competitorLandedAtMs = competitorLandedAtMs;
if (competitorTxHash) rec.competitorTxHash = competitorTxHash;
}

// ---- Phase 1 success-criteria reporting ----

summary(chain?: ChainName) {
const scoped = chain ? this.records.filter(r => r.opportunity.chain === chain) : this.records;

const seen = scoped.length;
const wouldHaveWon = scoped.filter(r => r.outcome === 'WOULD_HAVE_WON').length;
const wouldHaveLost = scoped.filter(r => r.outcome === 'WOULD_HAVE_LOST').length;
const skippedProfit = scoped.filter(r => r.outcome === 'SKIPPED_BELOW_MIN_PROFIT').length;
const skippedScore = scoped.filter(r => r.outcome === 'SKIPPED_LOW_SCORE').length;
const reverted = scoped.filter(r => r.outcome === 'REVERTED_IN_SIMULATION').length;

const reactionTimes = scoped
.map(r => r.ourHypotheticalReactionMs)
.filter((t): t is number => t !== undefined)
.sort((a, b) => a - b);

const avgReaction = reactionTimes.length
? reactionTimes.reduce((a, b) => a + b, 0) / reactionTimes.length
: null;

const p95Reaction = reactionTimes.length
? reactionTimes[Math.floor(reactionTimes.length * 0.95)]
: null;

const totalConservativeNetIfWon = scoped
.filter(r => r.outcome === 'WOULD_HAVE_WON')
.reduce((sum, r) => sum + r.opportunity.conservativeNetProfitUsd, 0);

return {
chain: chain ?? 'ALL',
opportunitiesSeen: seen,
wouldHaveWon,
wouldHaveLost,
winRate: wouldHaveWon + wouldHaveLost > 0
? (wouldHaveWon / (wouldHaveWon + wouldHaveLost) * 100).toFixed(1) + '%'
: 'n/a',
skippedBelowMinProfit: skippedProfit,
skippedLowScore: skippedScore,
revertedInSimulation: reverted,
avgReactionMs: avgReaction,
p95ReactionMs: p95Reaction,
hypotheticalNetProfitUsd: totalConservativeNetIfWon.toFixed(2),
};
}

// Every WOULD_HAVE_LOST record is a diagnosis question:
// were we slow, or did the competitor have better infra?
diagnoseLosses(chain?: ChainName) {
const scoped = (chain ? this.records.filter(r => r.opportunity.chain === chain) : this.records)
.filter(r => r.outcome === 'WOULD_HAVE_LOST');

return scoped.map(r => ({
id: r.opportunity.id,
chain: r.opportunity.chain,
ourReactionMs: r.ourHypotheticalReactionMs,
competitorReactionMs: r.competitorLandedAtMs,
marginMs: (r.competitorLandedAtMs ?? 0) - (r.ourHypotheticalReactionMs ?? 0),
conclusion:
(r.ourHypotheticalReactionMs ?? 0) < 20
? 'We were fast — likely outgunned by better infra (private relay, colocated node, etc.)'
: 'We were slow — look at decode/simulate/size timing breakdown',
}));
}

all() {
return this.records;
}
}
