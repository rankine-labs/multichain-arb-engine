// ============================================================================
// SIM-COMPARE step 3: COMPARE and REPORT.
//
// Plain English:
//   For every check we have the node's answer (the truth) and the fast
//   engine's answer. Each answer is read the same way the bot reads it:
//     profit  = the contract refused with InsufficientProfit(got > 0)
//     loss    = InsufficientProfit(0), or (flash loan) TransferFailed
//     fail    = any other refusal, or the call unexpectedly succeeded
//   and each check lands in exactly ONE group:
//     exact          same success flag AND byte-identical output (this means
//                    the same verdict and, for a profit, the same profit to
//                    the last unit, and the same error for a failure)
//     same verdict, different detail   (e.g. profit both sides, amounts differ)
//     different verdict                (e.g. node: profit, fast: fail)
//     fast unknown   the fast engine said "not sure" (NOT a match)
//     not answered   the fast engine has no answer yet (NOT a match)
//     node error     the node itself couldn't answer: left out, counted
//
//   HEADLINE MATCH RATE = exact / (every check the node answered).
//   "Unknown" and "not answered" count AGAINST it, so an engine can't look
//   good by refusing the hard ones. Coverage and the rate among answered
//   checks are shown next to it.
//
//   Gas: compared only where both sides report gas (follow-a-trade checks;
//   the bot's plain eth_call for standing gaps returns no gas).
// ============================================================================
import { ethers } from 'ethers';
import { Case, FastRecord, NodeRecord, RawAnswer } from './types';
import { median, pct } from './util';

const IFACE = new ethers.Interface([
  'error InsufficientProfit(uint256 got, uint256 wanted)',
  'error TransferFailed()',
]);
const SEL_PROFIT = IFACE.getError('InsufficientProfit')!.selector;
const SEL_TRANSFER = IFACE.getError('TransferFailed')!.selector;

export type Verdict = 'profit' | 'loss' | 'fail';
export interface Reading { verdict: Verdict; profit: bigint | null; error: string }

// Same rules as the bot's simulator.ts verdictFrom (kept short on purpose:
// only the two errors that decide profit/loss matter for the verdict; any
// other refusal is a "fail", identified by its 4-byte error code).
export function readAnswer(a: { success: boolean; output: string }, flash: boolean): Reading {
  if (a.success) return { verdict: 'fail', profit: null, error: 'call unexpectedly succeeded' };
  const out = (a.output ?? '0x').toLowerCase();
  const sel = out.slice(0, 10);
  if (sel === SEL_PROFIT) {
    try {
      const [got] = IFACE.decodeErrorResult('InsufficientProfit', out);
      const g = got as bigint;
      return g > 0n ? { verdict: 'profit', profit: g, error: 'InsufficientProfit' } : { verdict: 'loss', profit: 0n, error: 'InsufficientProfit(0)' };
    } catch { return { verdict: 'fail', profit: null, error: 'bad InsufficientProfit data' }; }
  }
  if (sel === SEL_TRANSFER && flash) return { verdict: 'loss', profit: null, error: 'TransferFailed (flash: loan not repaid)' };
  return { verdict: 'fail', profit: null, error: out === '0x' ? 'no revert data' : sel };
}

export type Group = 'exact' | 'same_verdict_diff' | 'diff_verdict' | 'fast_unknown' | 'not_answered' | 'node_error';
export interface Compared {
  id: string;
  group: Group;
  mode: Case['mode'];
  kinds: string;
  funding: Case['funding'];
  node?: Reading; fast?: Reading;
  profitDiff?: bigint;          // fast - node (start-coin base units), both profit
  profitDiffPct?: number;       // |diff| / node profit, %
  gasDiff?: number;             // fast - node, when both report gas
  prefixMismatch?: boolean;     // replayed trades succeeded/failed differently
  unknownWhy?: string;
  nodeError?: string;
  fastUs?: number;
  nodeMs?: number;
  severity: number;             // for "worst mismatches" (higher = worse)
}

export function compareOne(c: Case, n: NodeRecord | undefined, f: FastRecord | undefined): Compared {
  const base = { id: c.id, mode: c.mode, kinds: c.route.kinds, funding: c.funding };
  if (!n || n.status !== 'answer' || !n.raw) return { ...base, group: 'node_error', nodeError: n?.reason ?? 'no node answer yet', severity: 0 };
  const flash = c.funding === 'flash';
  const node = readAnswer(n.raw, flash);
  if (!f) return { ...base, group: 'not_answered', node, nodeMs: n.ms, severity: 0 };
  if (f.result.status === 'unknown') return { ...base, group: 'fast_unknown', node, unknownWhy: f.result.why, nodeMs: n.ms, severity: 0, ...(f.result.us !== undefined ? { fastUs: f.result.us } : {}) };
  const r = f.result;
  const fast = readAnswer(r, flash);
  const out: Compared = { ...base, group: 'exact', node, fast, nodeMs: n.ms, severity: 0, ...(r.us !== undefined ? { fastUs: r.us } : {}) };
  if (n.raw.gasUsed !== null && r.gasUsed !== null) out.gasDiff = Number(BigInt(r.gasUsed) - BigInt(n.raw.gasUsed));
  if (n.prefixStatuses !== undefined && r.prefixStatuses !== undefined) out.prefixMismatch = n.prefixStatuses !== r.prefixStatuses;
  const sameBytes = r.success === n.raw.success && r.output.toLowerCase() === n.raw.output.toLowerCase();
  if (node.verdict === 'profit' && fast.verdict === 'profit') {
    out.profitDiff = fast.profit! - node.profit!;
    const d = out.profitDiff < 0n ? -out.profitDiff : out.profitDiff;
    out.profitDiffPct = Number((d * 1_000_000n) / node.profit!) / 10_000;
  }
  if (sameBytes) out.group = 'exact';
  else if (node.verdict === fast.verdict) out.group = 'same_verdict_diff';
  else out.group = 'diff_verdict';
  // Severity: wrong verdict >> wrong profit (by %) >> other detail >> gas only.
  const g = Math.abs(out.gasDiff ?? 0);
  out.severity = out.group === 'diff_verdict' ? 3e9 + (node.verdict === 'profit' || fast.verdict === 'profit' ? 1e9 : 0)
    : out.group === 'same_verdict_diff' ? 1e9 + Math.min(1e9 - 1, (out.profitDiffPct ?? 0) * 1e6 + 1)
      : g > 0 ? Math.min(1e9 - 1, g) : 0;
  return out;
}

// ---- Totals -----------------------------------------------------------------
export interface Bucket {
  checks: number;           // node answered (the denominator)
  exact: number; sameVerdictDiff: number; diffVerdict: number; fastUnknown: number; notAnswered: number;
  nodeErrors: number;       // not in `checks`
  matchRatePct: number | null;        // exact / checks
  verdictMatchPct: number | null;     // (exact + same verdict) / checks
  coveragePct: number | null;         // fast answered / checks
  matchAmongAnsweredPct: number | null;
  gas: { compared: number; exact: number; medianAbsDiff: number | null; p95AbsDiff: number | null; maxAbsDiff: number | null };
  profit: { bothProfit: number; exactAmount: number; medianDiffPct: number | null; maxDiffPct: number | null };
  prefixMismatches: number;
}

const r1 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

export class Tally {
  private n = { checks: 0, exact: 0, sameVerdictDiff: 0, diffVerdict: 0, fastUnknown: 0, notAnswered: 0, nodeErrors: 0, prefixMismatches: 0, bothProfit: 0, exactAmount: 0, gasExact: 0 };
  private gas: number[] = [];
  private pd: number[] = [];
  add(x: Compared): void {
    if (x.group === 'node_error') { this.n.nodeErrors++; return; }
    this.n.checks++;
    if (x.group === 'exact') this.n.exact++;
    else if (x.group === 'same_verdict_diff') this.n.sameVerdictDiff++;
    else if (x.group === 'diff_verdict') this.n.diffVerdict++;
    else if (x.group === 'fast_unknown') this.n.fastUnknown++;
    else if (x.group === 'not_answered') this.n.notAnswered++;
    if (x.prefixMismatch) this.n.prefixMismatches++;
    if (x.gasDiff !== undefined) { this.gas.push(Math.abs(x.gasDiff)); if (x.gasDiff === 0) this.n.gasExact++; }
    if (x.profitDiff !== undefined) { this.n.bothProfit++; if (x.profitDiff === 0n) this.n.exactAmount++; this.pd.push(x.profitDiffPct ?? 0); }
  }
  result(): Bucket {
    const c = this.n.checks;
    const answered = this.n.exact + this.n.sameVerdictDiff + this.n.diffVerdict;
    const p = (a: number, b: number) => (b ? r1((100 * a) / b) : null);
    return {
      checks: c, exact: this.n.exact, sameVerdictDiff: this.n.sameVerdictDiff, diffVerdict: this.n.diffVerdict,
      fastUnknown: this.n.fastUnknown, notAnswered: this.n.notAnswered, nodeErrors: this.n.nodeErrors,
      matchRatePct: p(this.n.exact, c), verdictMatchPct: p(this.n.exact + this.n.sameVerdictDiff, c),
      coveragePct: p(answered, c), matchAmongAnsweredPct: p(this.n.exact, answered),
      gas: { compared: this.gas.length, exact: this.n.gasExact, medianAbsDiff: median(this.gas), p95AbsDiff: pct(this.gas, 0.95), maxAbsDiff: this.gas.length ? Math.max(...this.gas) : null },
      profit: { bothProfit: this.n.bothProfit, exactAmount: this.n.exactAmount, medianDiffPct: r1(median(this.pd)), maxDiffPct: r1(this.pd.length ? Math.max(...this.pd) : null) },
      prefixMismatches: this.n.prefixMismatches,
    };
  }
}

// Keeps only the N worst mismatches (bounded memory).
export class Worst<T extends { severity: number }> {
  private items: T[] = [];
  constructor(private readonly n = 20) {}
  add(x: T): void {
    if (x.severity <= 0) return;
    if (this.items.length < this.n) { this.items.push(x); return; }
    let minI = 0;
    for (let i = 1; i < this.items.length; i++) if (this.items[i]!.severity < this.items[minI]!.severity) minI = i;
    if (x.severity > this.items[minI]!.severity) this.items[minI] = x;
  }
  list(): T[] { return [...this.items].sort((a, b) => b.severity - a.severity); }
}

export const MATCH_RATE_DEFINITION =
  'MATCH RATE = checks where the fast engine gave the SAME success flag and BYTE-IDENTICAL output as the node ' +
  '(same verdict, same exact profit or same exact error), divided by ALL checks the node answered. ' +
  '"Fast unknown" and "not answered" count as NOT matching. Checks the node itself could not answer are left out and counted separately. ' +
  'Gas is reported separately and is not part of the match rate.';

// ---- Plain text table ----------------------------------------------------------
const pc = (x: number | null) => (x === null ? '-' : `${x.toFixed(1)}%`);
export function bucketLine(name: string, b: Bucket): string {
  return `${name.padEnd(22)} ${String(b.checks).padStart(6)} ${pc(b.matchRatePct).padStart(7)} ${pc(b.verdictMatchPct).padStart(8)} ${String(b.diffVerdict).padStart(6)} ${String(b.sameVerdictDiff).padStart(6)} ${String(b.fastUnknown + b.notAnswered).padStart(7)} ${String(b.nodeErrors).padStart(6)} ${(b.gas.compared ? `${b.gas.exact}/${b.gas.compared}` : '-').padStart(10)}`;
}
export const TABLE_HEAD = `${'group'.padEnd(22)} ${'checks'.padStart(6)} ${'match'.padStart(7)} ${'verdict'.padStart(8)} ${'wrong'.padStart(6)} ${'detail'.padStart(6)} ${'unknown'.padStart(7)} ${'nodeEr'.padStart(6)} ${'gas exact'.padStart(10)}`;

export function rawEq(a: RawAnswer, b: { success: boolean; output: string }): boolean {
  return a.success === b.success && a.output.toLowerCase() === b.output.toLowerCase();
}
