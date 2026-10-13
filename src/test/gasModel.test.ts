import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GasModel, GasCalibration, gasSettingsFromEnv, twoPoolKey, twoPoolAnyKey, loopKey, median, costsLine,
  defaultUnitsFor, routeKeyFor, DEFAULT_GAS_OWN, DEFAULT_GAS_LOAN, LiveGasSource,
} from '../core/gasModel';
import { loopGasUsd, loopGasUnits } from '../core/loopTrader';
import { readReplayAnswer, gasUsedOf } from '../execution/simulator';
import { LiveTradeTracker } from '../execution/liveTracker';

// Gas model (Oct 13): live gas x measured units x margin, $0.05 fallback when
// the reading is old/missing, calibration from our own trades, switch off =
// the old estimate.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// A fake live gas source: 0.01 gwei base fee, 100k parent-chain posting gas.
// cost = (units + 100k) * 1e7 wei * ethUsd / 1e18.
let clock = 1_000_000;
const L1 = 100_000n;
const fake = (readAtMs: number): LiveGasSource => ({
  gasReadAtMs: readAtMs,
  gasCostUsdFor: (units, ethUsd) => (ethUsd && ethUsd > 0 ? (Number(units + L1) * 1e7 / 1e18) * ethUsd : null),
});
let src: LiveGasSource | null = fake(clock);
let eth: number | null = 4000;
const settings = gasSettingsFromEnv({});
const oldCalls: number[] = [];
const oldUsd = (fb: number) => { oldCalls.push(fb); return 0.0222; }; // pretend old estimate
const calib = new GasCalibration(null, 50, () => clock);
const model = new GasModel(settings, calib, () => src, () => eth, oldUsd, () => clock);

// ---- settings
assert(settings.fromLive && settings.margin === 1.3 && settings.minUsd === 0.01 && settings.maxAgeMs === 30_000 && settings.minSamples === 10 && settings.fallbackUsd === 0.05,
  'defaults: on, margin 1.3x, floor 1 cent, 30 s max age, 10 samples, $0.05 fallback');
assert(!gasSettingsFromEnv({ GAS_FROM_LIVE: '0' }).fromLive && !gasSettingsFromEnv({ GAS_FROM_LIVE: 'off' }).fromLive, 'GAS_FROM_LIVE=0/off switches it off');
assert(gasSettingsFromEnv({ GAS_MARGIN: '1,3' }).margin === 1.3 && gasSettingsFromEnv({ GAS_MARGIN: '0.5' }).margin === 1.3, 'bad or below-1x margin falls back to 1.3 (never removes the margin)');
assert(gasSettingsFromEnv({ GAS_MARGIN: '1.5', GAS_MIN_USD: '0.02' }).margin === 1.5 && gasSettingsFromEnv({ GAS_MIN_USD: '0.02' }).minUsd === 0.02, 'valid settings are used');

// ---- live gas used when fresh, margin applied
const own = model.twoPool(false);
const expectedOwn = ((DEFAULT_GAS_OWN + 100_000) * 1e7 / 1e18) * 4000 * 1.3;
assert(own.source === 'live' && near(own.usd, expectedOwn), `fresh reading: own money = (335k + L1) x gas price x ETH x 1.3 = ${own.usd.toFixed(4)}`);
const loan = model.twoPool(true);
const expectedLoan = ((DEFAULT_GAS_LOAN + 100_000) * 1e7 / 1e18) * 4000 * 1.3;
assert(loan.source === 'live' && near(loan.usd, expectedLoan) && loan.usd > own.usd, 'loan uses 477k units (costs more than own money)');
assert(!own.calibrated && own.units === DEFAULT_GAS_OWN, 'no samples yet: fork-measured default units');

// floor
eth = 1; // tiny ETH price -> tiny cost
assert(near(model.twoPoolUsd(false), 0.01), 'floor: never below GAS_MIN_USD (1 cent)');
eth = 4000;
// ceiling is a warning only: value kept
eth = 4_000_000;
const hi = model.twoPool(false);
assert(hi.tooHigh && hi.usd > 0.5 && model.counts.tooHigh >= 1, 'above GAS_MAX_USD: flagged and still used (never lowered)');
eth = 4000;

// ---- fallback when stale / missing
clock += 30_001;
const stale = model.twoPool(false);
assert(stale.source === 'fallback' && stale.usd === 0.05 && model.staleReason === 'gas reading too old', 'reading older than 30 s: $0.05 fallback');
assert(model.twoPoolUsd(false, undefined, 2) === 2, 'fallback uses the caller\'s own fallback when given (research paths pass $2)');
src = fake(clock);
assert(model.twoPool(false).source === 'live' && model.staleReason === null, 'fresh again: live');
src = null;
assert(model.twoPool(false).usd === 0.05 && model.staleReason === 'no gas reading yet', 'no gas source: $0.05');
src = fake(0);
assert(model.twoPool(false).usd === 0.05, 'never read (time 0): $0.05');
src = fake(clock); eth = null;
assert(model.twoPool(false).usd === 0.05 && model.staleReason === 'ETH price unknown', 'ETH price unknown: $0.05');
eth = 4000;

// ---- calibration median and threshold
assert(median([3, 1, 2]) === 2 && median([4, 1, 3, 2]) === 2.5 && median([]) === null, 'median: odd, even, empty');
const k = twoPoolKey([2, 0], false);
assert(k === '2p:V2+V3:own' && twoPoolKey([0, 2], false) === k, 'key: exchange mix sorted (both directions share it)');
assert(twoPoolKey([4, 2], true) === '2p:V3+V4hook:loan' && loopKey(3) === 'loop:3', 'keys for loan / hooked V4 / loops');
assert(routeKeyFor([0, 2], true) === '2p:V2+V3:loan' && routeKeyFor([0, 2, 2], false) === 'loop:3', 'routeKeyFor: 2 hops = 2-pool, more = loop');
assert(defaultUnitsFor('2p:V2+V3:loan') === DEFAULT_GAS_LOAN && defaultUnitsFor('2p:any:own') === DEFAULT_GAS_OWN && defaultUnitsFor('loop:4') === loopGasUnits(4), 'default units per key');
for (let i = 0; i < 9; i++) model.notePractice(k, 300_000n + BigInt(i) * 1000n);
const nine = model.twoPool(false, [2, 0]);
assert(!nine.calibrated && nine.units === DEFAULT_GAS_OWN && nine.samples === 9, '9 samples: still the default (needs 10)');
model.notePractice(k, 309_000n);
const ten = model.twoPool(false, [2, 0]);
assert(ten.calibrated && ten.units === 304_500 && ten.samples === 10, `10 samples: median ${ten.units} used`);
assert(ten.usd < own.usd, 'calibrated lower gas -> lower cost than the default');
assert(calib.count(twoPoolAnyKey(false)) === 10 && model.twoPool(false).calibrated, 'samples also feed the funding-wide key (used when the exchanges are unknown)');
assert(!model.twoPool(true).calibrated, 'own-money samples do not calibrate loans');
assert(!calib.add(k, 10_000n) && !calib.add(k, 9_000_000n) && calib.count(k) === 10, 'implausible samples (10k, 9M) rejected');
const unknownMix = model.twoPool(false, [1, 3]);
assert(unknownMix.calibrated && unknownMix.units === 304_500, 'exchange mix without its own samples: funding-wide median');
// floor: calibrated units never below 75% of the default
const cheapKey = twoPoolKey([0, 0], true);
for (let i = 0; i < 10; i++) model.notePractice(cheapKey, 150_000n);
const cheap = model.twoPool(true, [0, 0]);
assert(cheap.calibrated && cheap.units === DEFAULT_GAS_LOAN * 0.75, `calibrated median 150k clamped up to 75% of the 477k default (${cheap.units})`);
// rolling window
const small = new GasCalibration(null, 5);
for (let i = 1; i <= 8; i++) small.add('loop:3', i * 100_000);
assert(small.count('loop:3') === 5 && small.median('loop:3') === 600_000, 'rolling window keeps the newest samples only');

// ---- receipts: parent-chain part removed; early reverts ignored
const rk = twoPoolKey([2, 2], true);
assert(model.noteReceipt(rk, 700_000n, 200_000n, true, DEFAULT_GAS_LOAN) && calib.median(rk) === 500_000, 'receipt: gasUsedForL1 taken out (700k - 200k = 500k)');
assert(!model.noteReceipt(rk, 150_000n, 0n, false, DEFAULT_GAS_LOAN), 'early revert (150k, under 60% of 477k) not counted');
assert(model.noteReceipt(rk, 450_000n, null, false, DEFAULT_GAS_LOAN) && calib.count(rk) === 2, 'late revert (ran most of the route) counted; no L1 split = whole gas');

// ---- loops
const loopModel = new GasModel(settings, new GasCalibration(null), () => fake(clock), () => 4000, oldUsd, () => clock);
const two = loopModel.twoPool(false).usd;
assert(near(loopModel.loopUsd(3), loopGasUsd(two, 3)), 'loop without samples: 2-pool own-money estimate scaled per pool (as before)');
for (let i = 0; i < 10; i++) loopModel.notePractice(loopKey(3), 400_000n);
assert(near(loopModel.loopUsd(3), ((400_000 + 100_000) * 1e7 / 1e18) * 4000 * 1.3), 'loop with 10 samples: its own median');

// ---- switch off = old behaviour
const off = new GasModel(gasSettingsFromEnv({ GAS_FROM_LIVE: '0' }), calib, () => fake(clock), () => 4000, oldUsd, () => clock);
oldCalls.length = 0;
const o1 = off.twoPool(true, [2, 0], 0.05);
assert(o1.source === 'old' && o1.usd === 0.0222 && oldCalls[0] === 0.05, 'off: the old estimate, with the caller\'s fallback');
assert(near(off.loopUsd(4, 0.05), loopGasUsd(0.0222, 4)), 'off: loops = old loopGasUsd(old estimate)');

// ---- persistence
const dir = mkdtempSync(join(tmpdir(), 'gascal-'));
const file = join(dir, 'gas-calibration.json');
const c1 = new GasCalibration(file);
for (let i = 0; i < 3; i++) c1.add('loop:4', 600_000 + i);
c1.maybeSave(true);
const saved = JSON.parse(readFileSync(file, 'utf8'));
assert(Array.isArray(saved.samples['loop:4']) && saved.samples['loop:4'].length === 3, 'saved to data/gas-calibration.json');
const c2 = new GasCalibration(file);
assert(c2.count('loop:4') === 3 && c2.median('loop:4') === 600_001, 'reloaded after a restart');

// ---- report line
const line = costsLine(own, settings, 3, 2, null);
assert(line.startsWith('Costs used: gas ') && line.includes('live, margin 1.3x') && line.includes('0/10 samples') && line.includes('dynamic fees from events: 3 pools (2 waiting'), `report line: ${line}`);
assert(costsLine(ten, settings, 1).includes('calibrated from 10 trades') && costsLine(ten, settings, 1).includes('1 pool'), 'report line: calibrated count, singular pool');
assert(costsLine(stale, settings, 0, 0, 'gas reading too old').includes('fallback: gas reading too old'), 'report line: fallback reason');
assert(costsLine(o1, settings, 0).includes('GAS_FROM_LIVE off'), 'report line: switched off');

// ---- practice checks report gas (eth_simulateV1 replay) -> passed through
const ans = readReplayAnswer([{ calls: [{ status: '0x0', gasUsed: '0x3d090', error: { message: 'execution reverted', data: '0xdeadbeef' } }] }], 1);
assert(ans.error?.gasUsed === '0x3d090' && gasUsedOf(ans.error?.gasUsed) === 250_000n, 'replay answer keeps gasUsed (0x3d090 = 250,000)');
const noGas = readReplayAnswer([{ calls: [{ status: '0x0', error: { message: 'execution reverted', data: '0xdeadbeef' } }] }], 1);
assert(noGas.error?.gasUsed === undefined && gasUsedOf(undefined) === null && gasUsedOf('junk') === null, 'no gasUsed from the node: nothing recorded');

// ---- live tracker hands the route key + success to the gas hook
const seen: any[] = [];
const lt = new LiveTradeTracker({
  provider: { getTransactionReceipt: async () => null } as any, ethUsd: () => 4000, tokenUsd: () => null,
  recordLoss: () => {}, noteGasUsed: (g, info) => seen.push({ g, info }), notify: () => {},
});
lt.record('0xabc', { expectedProfitUsd: 1, label: 'x', routeKey: '2p:V2+V3:own' }, { status: 0, gasUsed: 400_000n, gasPrice: 1n, logs: [] } as any);
assert(seen.length === 1 && seen[0].g === 400_000n && seen[0].info.routeKey === '2p:V2+V3:own' && seen[0].info.success === false && seen[0].info.hash === '0xabc', 'live tracker passes route key, hash and success to the gas hook');
