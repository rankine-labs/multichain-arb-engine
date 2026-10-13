import { MemReporter, MemReading, registerSize, clearSizes, readSizes, memLogMinutes, startMemReport } from '../core/memReport';
import { formatPlainHourly } from '../core/telegramFormatter';

// Memory report: the [mem] line is formatted right, a broken size counter
// doesn't break it, MEM_LOG=0 turns it off, and peaks are remembered.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const MB = 1024 * 1024;
// Fake readings we can change between samples.
let reading: MemReading = { rss: 987 * MB, heapUsed: 240 * MB, heapTotal: 610 * MB, external: 35 * MB, arrayBuffers: 12 * MB };
const rep = new MemReporter(() => reading, () => 4144 * MB);

// --- Formatting ---
clearSizes();
registerSize('opportunities', () => 1200);
registerSize('rival trades', () => 800);
const line = rep.line();
assert(line.startsWith('[mem] rss 987 MB · heap used 240 / total 610 / limit 4144 MB · external 35 MB · buffers 12 MB'), 'line starts with the memory numbers in MB');
assert(line.includes('peak rss 987 MB, peak heap used 240 MB'), 'line shows the peaks');
assert(line.endsWith('sizes: opportunities 1200, rival trades 800'), 'line ends with the registered sizes');

// --- A failing size counter is tolerated ---
registerSize('pools', () => { throw new Error('boom'); });
registerSize('loop cycles', () => NaN);
let ok = true, l2 = '';
try { l2 = rep.line(); } catch { ok = false; }
assert(ok, 'a throwing size counter does not break the line');
assert(l2.includes('pools ?') && l2.includes('loop cycles ?') && l2.includes('opportunities 1200'), 'broken counters show "?", the others still show');
assert(readSizes() === 'opportunities 1200, rival trades 800, pools ?, loop cycles ?', 'readSizes keeps registration order');

// --- Peaks tracked ---
reading = { ...reading, rss: 1500 * MB, heapUsed: 700 * MB };
rep.sample();
reading = { ...reading, rss: 900 * MB, heapUsed: 200 * MB };
const l3 = rep.line();
assert(rep.peakRss === 1500 * MB && rep.peakHeapUsed === 700 * MB, 'peaks remember the highest values');
assert(l3.includes('rss 900 MB') && l3.includes('peak rss 1500 MB, peak heap used 700 MB'), 'line shows current and peak separately');
const hour = rep.hourLine();
assert(hour === 'Memory: rss 900 MB (peak 1500), real data (heap used) 200 MB, heap limit 4144 MB', 'hourly report line format');

// --- Settings: on by default, MEM_LOG=0 disables ---
assert(memLogMinutes({}) === 5, 'default: every 5 minutes');
assert(memLogMinutes({ MEM_LOG_MIN: '10' }) === 10, 'MEM_LOG_MIN=10 -> every 10 minutes');
assert(memLogMinutes({ MEM_LOG_MIN: 'junk' }) === 5, 'bad MEM_LOG_MIN falls back to 5');
assert(memLogMinutes({ MEM_LOG: '0' }) === 0, 'MEM_LOG=0 -> off');
const logs: string[] = [];
assert(startMemReport({ MEM_LOG: '0' }, (s) => logs.push(s)) === null && logs.length === 0, 'MEM_LOG=0: nothing started, nothing logged');
const started = startMemReport({}, (s) => logs.push(s));
assert(started !== null && logs.length === 1 && logs[0].includes('every 5 min') && !logs[0].includes('snapshot'), 'default: started, snapshot off');

// --- Hourly report shows the memory line only when given ---
const base = {
  windowLabel: '13:06 to 13:56', live: false, feedOk: true, feedReconnects: 0,
  pairs: 60, spots: 261, pricesFrom: 'free' as const, freeNodeBusy: 2, differencesFound: 93,
  checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 3 }, checksAvailable: false,
  earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
  reactionMs: { typical: 900, slowest5pct: 1571 },
  topDifferences: [],
};
assert(formatPlainHourly({ ...base, memory: hour }).includes('Memory: rss 900 MB (peak 1500), real data (heap used) 200 MB'), 'hourly report includes the memory line');
assert(!formatPlainHourly(base).includes('Memory: rss'), 'hourly report omits it when MEM_LOG=0 (not given)');

clearSizes();
