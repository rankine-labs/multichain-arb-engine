// summarize.js — prints the results/*.json files as plain tables (times in microseconds; 1000 us = 1 ms).
'use strict';
const fs = require('fs');
const path = require('path');
const dir = process.argv[2] || 'results';
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.bench.json')).map((f) => f.replace('.bench.json', '')).sort();
const pad = (s, n) => String(s).padEnd(n);
const row = (cols, w) => cols.map((c, i) => pad(c, w[i])).join(' ');
const W = [28, 7, 9, 9, 9, 9, 9, 9];

console.log('\nCORRECTNESS (expected = anvil callTracer, tx-level gas)');
console.log(row(['fixture', 'exact', 'success', 'output', 'gas exp', 'gas revm', 'diff', 'exec-only'], [28, 7, 8, 7, 9, 9, 7, 9]));
for (const n of names) {
  const b = JSON.parse(fs.readFileSync(path.join(dir, n + '.bench.json')));
  const c = b.correctness;
  console.log(row([n, c.exact_match, c.success.match, c.output.match, c.gas.expected_gasUsed, c.gas.revm_tx_level_gas,
    c.gas.diff_tx_level_minus_expected, c.gas.revm_execution_only_gas], [28, 7, 8, 7, 9, 9, 7, 9]));
}

const t = (s) => [s.first_us, s.median_us, s.p90_us, s.p99_us, s.max_us];
console.log('\nIN-PROCESS, single sim (us)            first   median  p90     p99     max     prestate load ms');
for (const n of names) {
  const b = JSON.parse(fs.readFileSync(path.join(dir, n + '.bench.json')));
  console.log(row([n, '', ...t(b.timing_single_sim)], W), ' ', (b.prestate.json_parse_ms + b.prestate.state_load_ms).toFixed(2));
}
console.log('\nIN-PROCESS, chained A then B (us)      first   median  p90     p99     max');
for (const n of names) {
  const b = JSON.parse(fs.readFileSync(path.join(dir, n + '.bench.json')));
  console.log(row([n, '', ...t(b.chained.timing_A_plus_B)], W), ' B changed by A:', b.chained.B_changed_by_A, ' base untouched:', b.chained.base_state_untouched_after);
}
for (const [label, key] of [['NODE -> SOCKET -> REVM -> NODE, single (us)', 'round_trip_single'], ['NODE ROUND TRIP, chained A+B (us)', 'round_trip_chained_A_plus_B']]) {
  console.log(`\n${pad(label, 38)} first   median  p90     p99     max     | transport-only median/p99`);
  for (const n of names) {
    const f = path.join(dir, n + '.socket.json');
    if (!fs.existsSync(f)) continue;
    const s = JSON.parse(fs.readFileSync(f));
    const x = key === 'round_trip_single' ? s[key] : s[key] && s[key].timing_round_trip;
    if (!x) continue;
    console.log(row([n, '', ...t(x)], W), ' |', x.transport_overhead.median_us, '/', x.transport_overhead.p99_us);
  }
}
const any = names.map((n) => path.join(dir, n + '.socket.json')).find(fs.existsSync);
if (any) {
  const s = JSON.parse(fs.readFileSync(any)).round_trip_noop_floor;
  console.log(`\nSocket floor (no-op tx, ~zero EVM work): median ${s.median_us} us, p99 ${s.p99_us} us, max ${s.max_us} us`);
}
