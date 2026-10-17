// Tests for the Oct 15 measurement-only additions:
//   - core/realisticPnl.ts: the live-realistic rules (start coin, own-money
//     size, no loan), exclusion reasons, saving to file and day rollover
//   - core/stableTally.ts: aUSD / UUSD / USDe gap and win counters
//   - deploy/status-report.js realisticLines: reading the log lines never throws
//   - telegramFormatter: the hourly report shows the new lines
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RealisticPnl, realisticVerdict, readStartCoins } from '../core/realisticPnl';
import { StableTally, parseStableEnv, matchStableName } from '../core/stableTally';
import { formatPlainHourly, PlainHourlyInput } from '../core/telegramFormatter';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const USDG = A(1), WETH = A(2), ORBIO = A(3), AUSD = A(4), UUSD = A(5), USDE = A(6), LENDER = A(99);
const cfg = { startCoins: new Set([USDG, WETH]), ownMaxUsd: 2_000 };

// --- rules ------------------------------------------------------------------
assert(realisticVerdict({ startToken: USDG, sizeUsd: 1_500 }, cfg) === 'ok', 'USDG start, $1,500, no loan: counts');
assert(realisticVerdict({ startToken: WETH.toUpperCase().replace('0X', '0x'), sizeUsd: 2_000 }, cfg) === 'ok', 'WETH start at exactly the cap (any letter case): counts');
assert(realisticVerdict({ startToken: ORBIO, sizeUsd: 100 }, cfg) === 'otherCoin', 'ORBIO start: left out as another coin');
assert(realisticVerdict({ startToken: USDG, sizeUsd: 2_000.01 }, cfg) === 'overSize', 'over the own-money cap: left out as over size');
assert(realisticVerdict({ startToken: USDG, sizeUsd: NaN }, cfg) === 'overSize', 'broken size never counts as realistic');
assert(realisticVerdict({ startToken: USDG, sizeUsd: 500, lender: LENDER }, cfg) === 'loan', 'used a loan: left out as needed a loan');
assert(realisticVerdict({ startToken: ORBIO, sizeUsd: 5_000, lender: LENDER }, cfg) === 'otherCoin', 'first rule broken wins (coin before size before loan)');
assert(realisticVerdict({ startToken: USDG, sizeUsd: 5_000, lender: LENDER }, cfg) === 'overSize', 'size before loan');
const sc = readStartCoins('', [USDG, WETH]);
assert(sc.size === 2 && sc.has(USDG) && sc.has(WETH), 'REALISTIC_START_COINS unset: defaults USDG and WETH');
const sc2 = readStartCoins(` ${AUSD} , junk`, [USDG, WETH]);
assert(sc2.size === 1 && sc2.has(AUSD), 'REALISTIC_START_COINS set: uses it, ignores bad entries');

// --- totals, exclusions, saving, day rollover ---------------------------------
const file = join(mkdtempSync(join(tmpdir(), 'real-')), 'realistic.json');
let clock = Date.UTC(2026, 9, 15, 19, 0, 0); // 15:00 Toronto, Oct 15
const r = new RealisticPnl(file, cfg, 'America/Toronto', () => clock);
assert(r.record(5, { startToken: USDG, sizeUsd: 1_000 }) === 'ok', 'win recorded as realistic');
r.record(3, { startToken: WETH, sizeUsd: 300 });
r.record(10, { startToken: ORBIO, sizeUsd: 800 });
r.record(7, { startToken: USDG, sizeUsd: 9_000, lender: LENDER });
r.record(2, { startToken: USDG, sizeUsd: 1_000, lender: LENDER });
assert(r.record(-1, { startToken: USDG, sizeUsd: 10 }) === null, 'negative profit ignored');
assert(r.record(5_000, { startToken: USDG, sizeUsd: 10 }) === null, 'junk-size profit ignored (same limit as normal total)');
let s = r.summary();
assert(near(s.today.usd, 8) && s.today.count === 2, 'today: $8 from 2 realistic wins');
assert(near(s.today.excluded.otherCoin.usd, 10) && s.today.excluded.otherCoin.n === 1, 'excluded: other coin $10 (1)');
assert(near(s.today.excluded.overSize.usd, 7) && s.today.excluded.overSize.n === 1, 'excluded: over size $7 (1)');
assert(near(s.today.excluded.loan.usd, 2) && s.today.excluded.loan.n === 1, 'excluded: needed a loan $2 (1)');
const [l1, l2] = r.lines();
assert(l1 === 'live-realistic (USDG/WETH start, own money <= $2,000, no loan): today $8.00 from 2, 7 days $8.00', `line 1: ${l1}`);
assert(l2 === 'left out today: started in another coin $10.00 (1), exchange not live yet $0.00 (0), over own-money size $7.00 (1), needed a loan $2.00 (1)', `line 2: ${l2}`);
assert(!/\u2014/.test(l1 + l2), 'no em dashes in report lines');

r.save();
const r2 = new RealisticPnl(file, cfg, 'America/Toronto', () => clock);
assert(near(r2.summary().today.usd, 8) && r2.summary().today.excluded.loan.n === 1, 'totals survive a restart (saved file)');

clock = Date.UTC(2026, 9, 16, 3, 30, 0); // 23:30 Toronto, still Oct 15
r2.record(1, { startToken: USDG, sizeUsd: 10 });
assert(near(r2.summary().today.usd, 9), 'still the same Toronto day at 23:30');
clock = Date.UTC(2026, 9, 16, 5, 0, 0); // 01:00 Toronto, Oct 16
r2.record(4, { startToken: WETH, sizeUsd: 10 });
s = r2.summary();
assert(near(s.today.usd, 4) && s.today.count === 1 && s.today.excluded.otherCoin.n === 0, 'new Toronto day starts at zero (exclusions too)');
assert(near(s.weekUsd, 13) && s.weekCount === 4, '7-day total spans both days');
clock = Date.UTC(2026, 9, 24, 5, 0, 0); // 8 days later
assert(near(r2.summary().weekUsd, 0), '7-day total drops days older than 7');
clock = Date.UTC(2026, 11, 1, 5, 0, 0); // ~6 weeks later: a new day prunes old ones
r2.record(1, { startToken: USDG, sizeUsd: 10 });
r2.save();
const r3 = new RealisticPnl(file, cfg, 'America/Toronto', () => clock);
assert(near(r3.summary().weekUsd, 1), 'old days pruned, file still reads fine');

// A broken or odd file never breaks loading.
const bad = join(mkdtempSync(join(tmpdir(), 'real-')), 'bad.json');
writeFileSync(bad, '{"version":1,"days":{"2026-10-15":{"usd":"x"}}}');
const rb = new RealisticPnl(bad, cfg, 'America/Toronto', () => Date.UTC(2026, 9, 15, 19));
assert(rb.summary().today.usd === 0 && rb.lines()[1].includes('$0.00 (0)'), 'odd saved file: reads as zeros, no crash');
writeFileSync(bad, 'not json');
assert(new RealisticPnl(bad, cfg).summary().today.count === 0, 'unreadable file: starts at zero');

// --- other stablecoins ----------------------------------------------------------
assert(matchStableName('ausd') === 'aUSD' && matchStableName('USDE') === 'USDe' && matchStableName('USDG') === null, 'stable names matched ignoring case, USDG is not one');
const env = parseStableEnv(`aUSD:${AUSD},bogus:${A(7)},UUSD:not-an-address`);
assert(env.size === 1 && env.get(AUSD) === 'aUSD', 'OTHER_STABLES parsed, bad entries ignored');

const sf = join(mkdtempSync(join(tmpdir(), 'stab-')), 'stables.json');
let c2 = Date.UTC(2026, 9, 15, 19, 0, 0);
const t = new StableTally(sf, 'America/Toronto', () => c2, 3);
t.noteGaps([{ key: 'p1>p2', tokens: [ORBIO, AUSD], modelUsd: 2 }]); // no addresses yet: ignored
assert(t.today().aUSD.gaps === 0, 'nothing counted before addresses are known');
assert(t.line().includes('aUSD address not known yet'), 'report says when an address is not known');
t.addFromGroups([
  { token: AUSD, symbol: 'AUSD', group: 'Dollars' },
  { token: UUSD, symbol: 'UUSD', group: 'Dollars' },
  { token: USDE, symbol: 'USDe', group: 'ETH' },      // wrong group: ignored
  { token: USDG, symbol: 'USDG', group: 'Dollars' },  // not one of the three
]);
assert(t.knownNames().has('aUSD') && t.knownNames().has('UUSD') && !t.knownNames().has('USDe'), 'addresses learned from the verified Dollars group only');
t.setFromEnv(parseStableEnv(`USDe:${USDE}`));
assert(t.knownNames().has('USDe'), 'OTHER_STABLES adds a coin by hand');

t.noteGaps([
  { key: 'a>b', tokens: [ORBIO, AUSD], modelUsd: 2 },
  { key: 'c>d', tokens: [UUSD, WETH], modelUsd: 1.5 },
  { key: 'e>f', tokens: [ORBIO, USDG], modelUsd: 9 },   // no other stable: ignored
]);
t.noteGaps([{ key: 'a>b', tokens: [ORBIO, AUSD], modelUsd: 3 }, { key: 'c>d', tokens: [UUSD, WETH], modelUsd: 1.5 }]);
assert(t.today().aUSD.gaps === 1 && near(t.today().aUSD.modelUsd, 2), 'same open gap counted once (model $ at first sight)');
t.noteGaps([]); // both gaps closed
t.noteGaps([{ key: 'a>b', tokens: [ORBIO, AUSD], modelUsd: 4 }]);
assert(t.today().aUSD.gaps === 2 && near(t.today().aUSD.modelUsd, 6), 'a gap that closed and reopened counts again');
assert(t.today().UUSD.gaps === 1, 'UUSD gap counted');
// Memory guard: max 3 open gaps remembered in this test.
t.noteGaps(['1', '2', '3', '4', '5'].map((k) => ({ key: k, tokens: [USDE, ORBIO] as [string, string], modelUsd: 0.5 })));
assert((t as any).open.size <= 3, 'open-gap memory stays bounded');

t.noteWin([ORBIO, AUSD], AUSD, 2.5);   // tested starting from aUSD
t.noteWin([AUSD, ORBIO], ORBIO, 1);    // tested starting from ORBIO
t.noteWin([USDG, ORBIO], USDG, 9);     // no other stable: ignored
t.noteWin([AUSD, ORBIO], AUSD, -1);    // junk: ignored
const a = t.today().aUSD;
assert(a.wins === 2 && near(a.winUsd, 3.5) && a.startedHere === 1, 'aUSD wins: 2 for $3.50, 1 started in aUSD');
const line = t.line();
assert(line.startsWith('Other stables (today): aUSD gaps 2 ($6.00 model), wins 2 ($3.50, 1 started in aUSD) · UUSD gaps 1 ($1.50 model), wins 0 ($0.00, 0 started in UUSD) · USDe gaps'), `stables line: ${line}`);
assert(!/\u2014/.test(line), 'no em dashes in stables line');
t.save();
const t2 = new StableTally(sf, 'America/Toronto', () => c2);
assert(t2.today().aUSD.wins === 2 && t2.today().UUSD.gaps === 1, 'stable counts survive a restart');
c2 = Date.UTC(2026, 9, 16, 5, 0, 0); // next Toronto day
assert(t2.today().aUSD.gaps === 0 && t2.today().aUSD.wins === 0, 'stable counts start at zero on a new Toronto day');

// --- status page parsing never throws ---------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const status = require(join(__dirname, '..', '..', 'deploy', 'status-report.js'));
let threw = false;
let empty: string[] = [];
try {
  empty = status.realisticLines([]);
  status.realisticLines(undefined);
  status.realisticLines(null);
  status.realisticLines([null, 42, {}, '[pnl-real] live-realistic']);
} catch { threw = true; }
assert(!threw, 'realisticLines never throws on empty or odd input');
assert(empty.join('\n').includes('first figure after the next hourly report'), 'no log lines yet: friendly placeholder');
const got: string[] = status.realisticLines([
  '[pnl-real] live-realistic (USDG/WETH start, own money <= $2,000, no loan): today $1.00 from 1, 7 days $1.00',
  '[pnl] something else',
  `[pnl-real] ${l1}`,
  `[pnl-real] ${l2}`,
  `[stables] ${line}`,
]);
assert(got.length === 3 && got[0].includes('today $8.00 from 2') && got[1].includes('left out today') && got[2].startsWith('- Other stables (today): aUSD gaps 2'), 'status page shows the latest lines');

// --- hourly Telegram report -------------------------------------------------------
const hourly: PlainHourlyInput = {
  windowLabel: '13:00 to 14:00', live: false, feedOk: true, feedReconnects: 0, pairs: 10, spots: 20,
  pricesFrom: 'free', freeNodeBusy: 0, differencesFound: 5,
  checks: { done: 1, makeMoney: 1, loseMoney: 0, wouldFail: 0, nodeBusy: 0 }, checksAvailable: true,
  earned: { todayChecked: 22, todayCheckedCount: 5, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 22 },
  realistic: [l1, l2], otherStables: line,
  reactionMs: { typical: 50, slowest5pct: 80 }, topDifferences: [],
};
const msg = formatPlainHourly(hourly);
assert(msg.includes('Of that, live-realistic (USDG/WETH start, own money &lt;= $2,000, no loan): today $8.00 from 2'), 'hourly report shows the live-realistic total (HTML-escaped)');
assert(msg.includes('left out today: started in another coin $10.00 (1)') && msg.includes('Other stables (today): aUSD gaps 2'), 'hourly report shows exclusions and the stables line');
const { realistic: _r, otherStables: _o, ...older } = hourly;
assert(!formatPlainHourly(older).includes('live-realistic'), 'older callers without the new fields still work');
