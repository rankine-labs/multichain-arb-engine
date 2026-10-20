import type { LoopHour, LoopCheckSummary } from './loopTrader';

// ============================================================================
// LOOP REPORT -- the "Loop trades" block of the hourly report.
//
// Plain English: one short block, shown only when LOOP_TRADER is on:
//   Loop trades: found N, best $X, checked N, would make money N ($Y),
//   contract can't run N
//   plus how many were found at each loop length (3 to 8 pools), the 3 best
//   routes by coin names, how our finder did against rival bots' loop wins
//   (and how many of their loops were longer than we search), and how fast
//   the finder is.
// Practice only: nothing here is real money.
// ============================================================================

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n: number) => `$${n.toFixed(2)}`;
const secs = (ms: number) => (ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`);

// "3p 4, 4p 2, 5p 0, 6p -, 7p -, 8p -": a count per loop length, 3 to 8
// pools. Lengths longer than LOOP_MAX_POOLS aren't searched and show "-".
export function byLengthText(counts: number[], maxPools: number): string {
  const parts: string[] = [];
  for (let n = 3; n <= 8; n++) parts.push(`${n}p ${n > maxPools ? '-' : counts[n] ?? 0}`);
  return parts.join(', ');
}

// "check vs estimate: median estimate $0.40, median result -$0.02, median
// delay 0.6 s; losses quick (<1s) 12, slow 3". Quick losses = the estimate
// itself was wrong (prices hadn't moved yet); slow losses can also be a
// rival taking the gap first. A loss counts as minus gas in the median
// result (the contract doesn't say how much a losing check lost).
const signedMoney = (n: number) => (n < 0 ? `-$${(-n).toFixed(2)}` : money(n));
export function checkVsEstimateText(cv: LoopCheckSummary): string {
  const est = cv.medianEstUsd === null ? 'n/a' : signedMoney(cv.medianEstUsd);
  const res = cv.medianResultUsd === null ? 'n/a' : signedMoney(cv.medianResultUsd);
  const dly = cv.medianDelayMs === null ? 'n/a' : `${(cv.medianDelayMs / 1_000).toFixed(1)} s`;
  const fail = cv.topFail ? `; top reason it wouldn't go through: ${esc(cv.topFail[0])} (${cv.topFail[1]})` : '';
  return `check vs estimate: median estimate ${est}, median result ${res}, median delay ${dly}; losses quick (<1s) ${cv.lossesQuick}, slow ${cv.lossesSlow}${fail}`;
}

// "model vs check (profit before gas): right after trigger 4: model said
// $1.20, check said $0.30, gap 75% (3 lost); latest 2: ...". One part per
// check timing (LOOP_MODEL_VS_CHECK). A losing check counts as $0 (the
// contract doesn't say how much it lost), so the real gap on losses is
// at least what is shown. null = nothing to show.
export function modelVsCheckText(cv: LoopCheckSummary): string | null {
  const rows = cv.modelVsCheck;
  if (!rows || !rows.length) return null;
  const parts = rows.map((r) => {
    const gap = r.modelUsd > 0 ? `${Math.round((1 - r.checkUsd / r.modelUsd) * 100)}%` : 'n/a';
    const lost = r.losses ? ` (${r.losses} lost, loss size unknown so counted as $0)` : '';
    return `${esc(r.timing)} ${r.n}: model said ${signedMoney(r.modelUsd)}, check said ${signedMoney(r.checkUsd)}, gap ${gap}${lost}`;
  });
  return `model vs check (profit before gas, by timing): ${parts.join('; ')}`;
}

// "coins tax-tested 41 (taxed 2: MCD, XYZ; blocked 0), pools left out 6,
// waiting for coin test 3, benched routes 4 (now 2), skipped benched 120".
// COIN TAX TEST + ROUTE MEMORY (Oct 20). null = both off.
export function coinsText(h: LoopHour): string | null {
  const c = h.coins;
  if (!c) return null;
  const parts: string[] = [];
  if (c.tax) {
    const names = c.tax.taxedNames.length ? `: ${c.tax.taxedNames.join(', ')}` : '';
    parts.push(`coins tax-tested ${c.tax.tested} (taxed ${c.tax.taxed}, blocked ${c.tax.blocked}${names})`);
    if (c.taxPools) parts.push(`pools left out ${c.taxPools}`);
    if (c.waitTest) parts.push(`waiting for coin test ${c.waitTest}`);
    if (c.tax.waiting) parts.push(`coin tests queued ${c.tax.waiting}`);
    if (c.tax.unclear) parts.push(`coin tests unclear ${c.tax.unclear}${c.tax.topUnclear ? ` (mostly: ${c.tax.topUnclear[0]})` : ''}`);
  }
  if (c.benchStarts || c.benchedNow || c.benchedSkips) parts.push(`benched routes ${c.benchStarts} (now ${c.benchedNow}), skipped benched ${c.benchedSkips}`);
  return parts.length ? parts.join(', ') : null;
}

// ONE plain log line with the loop numbers, for the status page
// (deploy/status-report.js reads the bot's log, it can't see Telegram).
//   label: "hour" for the full hour (logged when the hourly report takes the
//   numbers), or "hour so far (N min)" for the 15 minute line.
// Example:
//   [loop] hour: found 505, best $8.87, checked 39, would make 1 ($0.14),
//   lost 37, wouldn't go through 1, can't run 0, by length 3p 115 4p 63 5p 327
//   | model vs check (profit before gas, by timing): latest 30: ...
// Only lengths we search are listed. No HTML, kept on one line.
// node (optional): which node loop checks use and its pauses (core/loopNode.ts
// loopNodeText), added after "by length" so the status page's 700 character
// cut never hides it. Missing = the line is exactly as before.
export function loopLogLine(h: LoopHour, maxPools: number, label: string, node?: string): string {
  const lens: string[] = [];
  for (let n = 3; n <= Math.min(8, maxPools); n++) lens.push(`${n}p ${h.foundByLen[n] ?? 0}`);
  const parts = [
    `found ${h.found}`, `best ${money(h.bestUsd)}`, `checked ${h.checked}`,
    `would make ${h.wouldMake} (${money(h.wouldMakeUsd)})`, `lost ${h.lost}`,
    `wouldn't go through ${h.failed}`, `can't run ${h.cantRun}`,
  ];
  if (h.skippedCap) parts.push(`not checked ${h.skippedCap}`);
  parts.push(`by length ${lens.join(' ')}`);
  if (node) parts.push(node);
  const coins = coinsText(h);
  if (coins) parts.push(coins); // plain text (escaped only in the Telegram block)
  // The model vs check text is written for Telegram (HTML escaped): undo that.
  const mvc = h.checkVsEstimate ? modelVsCheckText(h.checkVsEstimate) : null;
  const plain = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s*\n\s*/g, ' ');
  return `[loop] ${label}: ${parts.join(', ')}${mvc ? ` | ${plain(mvc)}` : ''}`;
}

// extra: the loop trader's extra single pools (core/loopExtraPools.ts), when on.
export function formatLoopHour(h: LoopHour, maxPools: number, extra?: { fresh: number; selected: number } | null): string {
  const L: string[] = [];
  L.push(`<b>Loop trades</b> (3-${maxPools} pool loops, practice only, never sent)`);
  L.push(`Loop trades: found ${h.found}, best ${money(h.bestUsd)}, checked ${h.checked}, would make money ${h.wouldMake} (${money(h.wouldMakeUsd)}), contract can't run ${h.cantRun}`);
  L.push(`  found by length: ${byLengthText(h.foundByLen, maxPools)}`);
  if (h.checked) L.push(`  checks that lost: ${h.lost}, wouldn't go through: ${h.failed}`);
  const cv = h.checkVsEstimate;
  if (cv && cv.n) L.push(`  ${checkVsEstimateText(cv)}`);
  const mvc = cv ? modelVsCheckText(cv) : null;
  if (mvc) L.push(`  ${mvc}`);
  if (h.skippedCap) L.push(`  not checked (loop check limit or line busy): ${h.skippedCap}`);
  const coins = coinsText(h);
  if (coins) L.push(`  ${esc(coins)}`);
  if (h.cantRunWhy.length) L.push(`  can't run because: ${h.cantRunWhy.slice(0, 3).map(([w, n]) => `${esc(w)} ${n}`).join('; ')}`);
  h.topRoutes.forEach((r, i) => L.push(`  ${i + 1}) ${esc(r.label)}: ${r.n}x, best ${money(r.bestUsd)}`));
  const rv = h.rival;
  if (rv.loops) {
    const bot = rv.topBot ? ` (busiest: ${esc(rv.topBot[0].slice(0, 8))} ${rv.topBot[1]})` : '';
    const lead = rv.leadMsMedian !== null ? `, usually ${secs(rv.leadMsMedian)} before we read their trade` : '';
    const unseen = rv.unseen ? `, ${rv.unseen} not fully seen` : '';
    L.push(`Race vs rival loops: they won ${rv.loops}${bot}; ${rv.longer} were longer than our max of ${maxPools} pools${unseen}; of the other ${rv.comparable}, we found ${rv.weFound}${lead}`);
  }
  if (extra) L.push(`  extra single pools watched: ${extra.selected} (${extra.fresh} with a fresh price now)`);
  if (h.updates) {
    const rb = h.rebuild ? `; last list rebuild ${secs(h.rebuild.totalMs)} in slices of at most ${h.rebuild.maxSliceMs.toFixed(1)} ms` : '';
    L.push(`Finder speed: ${h.updates} updates, typical ${h.medianMs!.toFixed(1)} ms, slowest ${h.slowestMs!.toFixed(1)} ms; ${h.cycles} loops watched${h.capped ? ' (list hit its cap)' : ''} (${byLengthText(h.cyclesByLen, maxPools)})${rb}${h.skippedScans ? `; ${h.skippedScans} scans skipped (nothing changed)` : ''}`);
  }
  return L.join('\n');
}
