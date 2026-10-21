// ============================================================================
// Reads every results/*.json and prints the summary tables used in results.md.
// Run: node summarize.js
// ============================================================================
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'results');
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const R = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const C = R.checks;
  const per100 = (n) => ((100 * n) / R.ops.sent).toFixed(1);
  const gasDiffs = Object.entries(C.lenient.gasDiffHist).filter(([k]) => k !== '0').map(([k, v]) => [Number(k), v]);
  const gasRange = gasDiffs.length ? `${Math.min(...gasDiffs.map((x) => x[0]))}..${Math.max(...gasDiffs.map((x) => x[0]))}` : '-';
  rows.push({
    run: `${R.type}/${R.variant}/s${R.seed}`,
    ops: `${R.ops.succeeded}/${R.ops.sent}`, blocks: R.blocks, events: R.events.total,
    checks: C.total, 'profit>0': C.profitPositive, 'node=engine(true)': `${C.nodeVsEngineTruth.outputMatch}+gas${C.nodeVsEngineTruth.gasEqual}`,
    'copy out ==': C.lenient.outputMatch, 'copy out !=': C.lenient.mismatch, 'copy gas ==': C.lenient.gasEqual, 'gas diff range': gasRange,
    'strict ok/needsNode/WRONG': `${C.strict.known}/${C.strict.needsNode}/${C.strict.knownMismatch}`,
    'reRead ev/100ops': per100(R.reReads.events), 'reRead slots/100ops': per100(R.reReads.slots),
    replays: R.replays.calls, 'replay FAILED': Object.entries(R.replays.byReason).filter(([k]) => k.includes('FAILED')).reduce((a, [, v]) => a + v, 0),
    'unsound slots': R.stateDiff.unsound, 'neg.ctrl': `${R.negativeControl?.differencesDetected}/${R.negativeControl?.checks}`,
  });
}
console.table(rows);
// Detail per run (categories) for results.md
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const R = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log(`\n### ${R.type}/${R.variant}/s${R.seed}`);
  console.log('ops by kind:', JSON.stringify(R.ops.byKind));
  console.log('events:', JSON.stringify(R.events.byName));
  console.log('re-reads by reason:', JSON.stringify(R.reReads.byReason));
  console.log('replays:', JSON.stringify(R.replays.byReason));
  console.log('slots the copy had WRONG at some block end (by name, count of slot-blocks):', JSON.stringify(R.stateDiff.byCategory));
  console.log('slots the check READ that differed:', JSON.stringify(R.checks.readDiffByCategory), 'checks with any:', R.checks.checksWithReadDiff);
  console.log('strict: missing by category:', JSON.stringify(R.checks.strict.missingByCategory));
  console.log('other reverts:', JSON.stringify(R.checks.revertKinds));
  console.log('gas diff histogram (copy - true):', JSON.stringify(R.checks.lenient.gasDiffHist));
  if (R.checks.lenient.firstMismatches.length) console.log('first mismatches:', JSON.stringify(R.checks.lenient.firstMismatches.slice(0, 3).map((m) => ({ check: m.check, ...m.decoded }))));
}
