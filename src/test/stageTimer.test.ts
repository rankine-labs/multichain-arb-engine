import { StageStats, StageTimers, StageTrace, formatStages, medianP95 } from '../core/stageTimer';
import { formatPlainHourly } from '../core/telegramFormatter';

// Stage timers ("where the time goes"): each trade's lap times are added up
// per stage, reported as median + p95, with counts of RPC calls that happened
// while a trade was waiting. Measurement only.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// 1. Median / p95 maths.
{
  const r = medianP95([5, 1, 3, 2, 4]);
  assert(r.n === 5 && r.median === 3 && r.p95 === 5, `median/p95 of 1..5 (got ${r.median}/${r.p95})`);
  const e = medianP95([]);
  assert(e.n === 0 && e.median === null && e.p95 === null, 'empty list -> no numbers, no crash');
}

// 2. A trace records the time between marks into every window it feeds.
{
  const a = new StageStats(), b = new StageStats();
  const t = new StageTrace([a, b], 1_000);   // trade received at t=1000 ms
  t.mark('decode', 1_002);                   // 2 ms
  t.mark('lookup', 1_002.5);                 // 0.5 ms
  t.mark('prices', 1_082.5);                 // 80 ms (an RPC re-read)
  t.mark('math', 1_085);                     // 2.5 ms
  t.mark('checks', 1_086);                   // 1 ms
  t.addFire({ queueMs: 0, signMs: 2, sendMs: 15 });
  const s = a.summary();
  assert(s.stages.decode.median === 2 && s.stages.lookup.median === 0.5 && s.stages.prices.median === 80, 'decode / lookup / prices laps recorded');
  assert(s.stages.math.median === 2.5 && s.stages.checks.median === 1, 'math / checks laps recorded');
  assert(s.stages.queue.median === 0 && s.stages.sign.median === 2 && s.stages.send.median === 15, 'queue / sign / send come from the fire result');
  assert(b.summary().stages.prices.median === 80, 'second window (hourly) gets the same laps');
}

// 3. Aggregation over many trades + RPC counters + the report line.
{
  const st = new StageStats();
  for (let i = 1; i <= 100; i++) { st.add('lookup', i > 90 ? 120 : 0.2); st.add('prices', i <= 90 ? 1 : 50); st.add('sign', 2); }
  st.noteLookupRpc(false); st.noteLookupRpc(false); st.noteLookupRpc(true);
  st.notePriceRefresh(80); st.notePriceRefresh(60);
  st.noteTrustedWs(4);
  const sum = st.summary({ p50: 0.5, p99: 12 });
  assert(sum.stages.lookup.median === 0.2 && sum.stages.lookup.p95 === 120, 'slow lookups (10%) do not move the median');
  assert(sum.stages.prices.p95 === 50, `p95 picks up the slow 10% (got ${sum.stages.prices.p95})`);
  assert(sum.lookupRpc === 3 && sum.lookupRpcWatched === 1, 'RPC lookups counted, watched-pair ones separately');
  assert(sum.priceRefresh.n === 2 && sum.priceRefresh.median === 80, 'price re-reads counted with their ms');
  const line = formatStages(sum, 'median');
  assert(line.startsWith('Where the time goes (median): '), 'line starts with the plain heading');
  assert(line.includes('lookup 0.2 ms (RPC 3x, 1 on watched pairs)'), `lookup shows RPC count (${line})`);
  assert(line.includes('prices 1 ms (refresh 2x, 80 ms; WebSocket-trusted 4x)'), `prices shows refresh count + ms (${line})`);
  assert(line.includes('sign 2 ms') && !line.includes('send'), 'stages with no samples are left out');
  assert(line.includes('(event loop delay) p50 0.5 ms, p99 12 ms'), 'event-loop delay shown on the median line');
  const p95 = formatStages(sum, 'p95');
  assert(p95.includes('lookup 120 ms') && p95.includes('prices 50 ms'), `p95 line uses the slow values (${p95})`);
  st.reset();
  const after = st.summary();
  assert(after.stages.lookup.n === 0 && after.lookupRpc === 0 && after.priceRefresh.n === 0 && after.trustedWs === 0, 'reset starts a fresh window');
  assert(formatStages(after).includes('no trades measured yet'), 'empty window says so plainly');
}

// 4. Memory stays bounded on a busy window.
{
  const st = new StageStats();
  for (let i = 0; i < 20_000; i++) st.add('math', i % 10);
  const s = st.summary();
  assert(s.stages.math.n === 5_000, `at most 5,000 samples kept per stage (kept ${s.stages.math.n})`);
  assert(s.stages.math.median !== null && s.stages.math.median >= 3 && s.stages.math.median <= 6, `sampled median still fair (${s.stages.math.median})`);
}

// 5. StageTimers: two windows, take() resets only the one taken.
{
  const timers = new StageTimers(false);
  const t = timers.begin(0);
  t.mark('decode', 3);
  timers.noteLookupRpc(true);
  const five = timers.take('fiveMin');
  assert(five.median.includes('wait+decode 3 ms') && five.median.includes('lookup RPC 1x (1 on watched pairs)'), `RPC lookups shown even when no trade finished the lookup stage (${five.median})`);
  assert(five.summary.lookupRpc === 1, 'lookup RPC counted in the 5-min window');
  assert(timers.fiveMin.summary().stages.decode.n === 0, '5-min window reset after take');
  assert(timers.hour.summary().stages.decode.n === 1, 'hourly window untouched by the 5-min take');
  const hour = timers.take('hour');
  assert(hour.p95.startsWith('Where the time goes (p95)'), 'hourly take gives a p95 line too');
}

// 6. The hourly Telegram report prints both lines.
{
  const msg = formatPlainHourly({
    windowLabel: '13:00 to 14:00', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 2,
    pricesFrom: 'free', freeNodeBusy: 0, differencesFound: 0,
    checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 0 }, checksAvailable: true,
    earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
    reactionMs: { typical: 10, slowest5pct: 30 }, topDifferences: [],
    speed: { median: 'Where the time goes (median): lookup 0 ms', p95: 'Where the time goes (p95): lookup 5 ms' },
  });
  assert(msg.includes('Where the time goes (median): lookup 0 ms'), 'hourly report shows the median line');
  assert(msg.includes('Slowest 5%: lookup 5 ms'), 'hourly report shows the slowest-5% line');
}
