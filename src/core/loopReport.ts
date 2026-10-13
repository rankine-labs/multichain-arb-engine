import type { LoopHour } from './loopTrader';

// ============================================================================
// LOOP REPORT -- the "Loop trades" block of the hourly report.
//
// Plain English: one short block, shown only when LOOP_TRADER is on:
//   Loop trades: found N, best $X, checked N, would make money N ($Y),
//   contract can't run N
//   plus the 3 best routes by coin names, how our finder did against rival
//   bots' loop wins, and how fast the finder is.
// Practice only: nothing here is real money.
// ============================================================================

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n: number) => `$${n.toFixed(2)}`;
const secs = (ms: number) => (ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`);

// extra: the loop trader's extra single pools (core/loopExtraPools.ts), when on.
export function formatLoopHour(h: LoopHour, maxPools: number, extra?: { fresh: number; selected: number } | null): string {
  const L: string[] = [];
  L.push(`<b>Loop trades</b> (3-${maxPools} pool loops, practice only, never sent)`);
  L.push(`Loop trades: found ${h.found}, best ${money(h.bestUsd)}, checked ${h.checked}, would make money ${h.wouldMake} (${money(h.wouldMakeUsd)}), contract can't run ${h.cantRun}`);
  if (h.checked) L.push(`  checks that lost: ${h.lost}, wouldn't go through: ${h.failed}`);
  if (h.skippedCap) L.push(`  not checked (loop check limit or line busy): ${h.skippedCap}`);
  if (h.cantRunWhy.length) L.push(`  can't run because: ${h.cantRunWhy.slice(0, 3).map(([w, n]) => `${esc(w)} ${n}`).join('; ')}`);
  h.topRoutes.forEach((r, i) => L.push(`  ${i + 1}) ${esc(r.label)}: ${r.n}x, best ${money(r.bestUsd)}`));
  const rv = h.rival;
  if (rv.loops) {
    const bot = rv.topBot ? ` (busiest: ${esc(rv.topBot[0].slice(0, 8))} ${rv.topBot[1]})` : '';
    const lead = rv.leadMsMedian !== null ? `, usually ${secs(rv.leadMsMedian)} before we read their trade` : '';
    L.push(`Race vs rival loops: they won ${rv.loops}${bot}; ${rv.tooLong} longer than ${maxPools} pools or not fully seen; of the other ${rv.comparable}, we found ${rv.weFound}${lead}`);
  }
  if (extra) L.push(`  extra single pools watched: ${extra.selected} (${extra.fresh} with a fresh price now)`);
  if (h.updates) L.push(`Finder speed: ${h.updates} updates, typical ${h.medianMs!.toFixed(1)} ms, slowest ${h.slowestMs!.toFixed(1)} ms; ${h.cycles} loops watched${h.capped ? ' (list hit its cap)' : ''}`);
  return L.join('\n');
}
