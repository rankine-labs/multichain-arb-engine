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
// Memory: records are kept ~26 h (enough for the hourly and daily reports)
// and capped in number, and the raw trigger transaction is dropped (it was
// the bulk of each record). Before this, every record lived forever and
// memory crept up ~10 MB an hour.
static KEEP_MS = 26 * 3600_000;
static MAX_RECORDS = 50_000;

record(entry: ShadowRecord, now = Date.now()) {
const ev = entry.opportunity.triggeringEvent as any;
if (ev && ev.raw !== undefined) entry.opportunity = { ...entry.opportunity, triggeringEvent: { ...ev, raw: undefined } };
this.records.push(entry);
// Prune occasionally (cheap): oldest first, by age then by count.
if (this.records.length % 500 === 0 || this.records.length > ShadowLogger.MAX_RECORDS) {
const cutoff = now - ShadowLogger.KEEP_MS;
let drop = 0;
while (drop < this.records.length && this.records[drop].opportunity.scoredAtMs < cutoff) drop++;
drop = Math.max(drop, this.records.length - ShadowLogger.MAX_RECORDS);
if (drop > 0) this.records.splice(0, drop);
}
}
get size() { return this.records.length; }

// Call this after checking the actual chain state post-opportunity
resolve(opportunityId: string, outcome: ShadowOutcome, competitorLandedAtMs?: number, competitorTxHash?: string) {
const rec = this.records.find(r => r.opportunity.id === opportunityId);
if (!rec) return;
rec.outcome = outcome;
if (competitorLandedAtMs !== undefined) rec.competitorLandedAtMs = competitorLandedAtMs;
if (competitorTxHash) rec.competitorTxHash = competitorTxHash;
}

// ---- Phase 1 success-criteria reporting ----

// Stats for opportunities scored in a time window (e.g. the last hour).
// summary() below is cumulative since the process started, so it can't
// answer "what happened THIS hour"; this can.
windowStats(sinceMs: number, untilMs: number = Date.now()) {
const scoped = this.records.filter(r => {
const t = r.opportunity.scoredAtMs;
return t >= sinceMs && t < untilMs;
});
const won = scoped.filter(r => r.outcome === 'WOULD_HAVE_WON');
const lost = scoped.filter(r => r.outcome === 'WOULD_HAVE_LOST');

const reactionTimes = scoped
.map(r => r.ourHypotheticalReactionMs)
.filter((t): t is number => t !== undefined)
.sort((a, b) => a - b);

const nets = (rs: typeof scoped) => rs.map(r => r.opportunity.conservativeNetProfitUsd);
return {
seen: scoped.length,
won: won.length,
lost: lost.length,
netUsd: nets(won).reduce((a, b) => a + b, 0),
avgReactionMs: reactionTimes.length ? reactionTimes.reduce((a, b) => a + b, 0) / reactionTimes.length : null,
p95ReactionMs: reactionTimes.length ? reactionTimes[Math.floor(reactionTimes.length * 0.95)] : null,
// Typical (middle) reaction time: unlike the average, a few very slow
// decisions can't drag it up. Used by the plain-English hourly report.
medianReactionMs: reactionTimes.length ? reactionTimes[Math.floor(reactionTimes.length / 2)] : null,
bestWonUsd: won.length ? Math.max(...nets(won)) : null,
largestLostUsd: lost.length ? Math.max(...nets(lost)) : null,
};
}

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
