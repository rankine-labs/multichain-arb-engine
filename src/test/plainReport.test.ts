import { formatPlainHourly, formatPlainDaily, plainSpot } from '../core/telegramFormatter';

// The plain-English Telegram report: readable labels, good/bad markers,
// and a "needs attention" line only when something needs the owner.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const base = {
  windowLabel: '13:06 to 13:56', live: false, feedOk: true, feedReconnects: 0,
  pairs: 60, spots: 261, pricesFrom: 'free' as const, freeNodeBusy: 2, differencesFound: 93,
  checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 3 }, checksAvailable: false,
  earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 179.28, todayUncheckedCount: 5, weekChecked: 0 },
  reactionMs: { typical: 900, slowest5pct: 1571 },
  otherBots: { timed: 0, theirMs: null, oursMs: null, weBeat: 0 },
  topDifferences: [
    { pair: 'WETH/ROBINFUN', pct: 6.98, buyAt: 'uniswap-v3 1%', sellAt: 'uniswap-v2' },
    { pair: 'WETH/Liluni', pct: 4.83, buyAt: 'uniswap-v3 1%', sellAt: 'uniswap-v4 0.3% ETH' },
  ],
};
const msg = formatPlainHourly(base);
console.log('----- sample -----\n' + msg.replace(/<\/?b>/g, '') + '\n------------------');
assert(!/p95|spread|pools\b|gap/i.test(msg), 'no jargon words (p95, spread, pools, gap)');
assert(msg.includes('Price differences found:</b> 93'), 'uses "price differences"');
assert(msg.includes('checking is off') && msg.includes('QuickNode'), 'says checks are off and what fixes it');
assert(msg.includes('Looks good but not checked yet: $179.28 from 5 (not trustworthy)'), 'unchecked money labelled as not trustworthy');
assert(msg.includes('Target: under 0.10 s ❌'), 'reaction time shows target and ❌');
assert(plainSpot('uniswap-v4 0.3% ETH') === 'Uniswap V4 (0.3% fee, ETH)', 'trading spot names are plain');

const healthy = formatPlainHourly({ ...base, checks: { done: 12, makeMoney: 3, loseMoney: 7, wouldFail: 2, nodeBusy: 0 }, checksAvailable: true, reactionMs: { typical: 40, slowest5pct: 90 } });
assert(healthy.includes('✅ Nothing needs your attention.') && healthy.includes('would make money: 3'), 'healthy hour: counts shown, nothing needs attention');
const down = formatPlainHourly({ ...base, feedOk: false, pricesFrom: 'backup' });
assert(down.includes('live trade feed is down') && down.includes('backup'), 'problems listed in plain sentences');
assert(msg.length < 4000, 'fits in one Telegram message');
const daily = formatPlainDaily({ dateLabel: 'Tue Oct 6', differencesFound: 1200, earnedChecked: 0, earnedCheckedCount: 0, weekChecked: 0, feedUptimePct: 99.8 });
assert(daily.includes('DAILY SUMMARY') && daily.includes('99.8%'), 'daily summary in plain words');

// Node usage lines + warnings at 80% and 100%.
const usage = formatPlainHourly({ ...base, checksAvailable: true, checks: { done: 3, makeMoney: 1, loseMoney: 2, wouldFail: 0, nodeBusy: 0 },
  nodeUsage: [
    { name: 'public', used: 52000, daily: Infinity },
    { name: 'quicknode', used: 11500, daily: 14000 },
    { name: 'alchemy', used: 30000, daily: 30000 },
  ] });
assert(usage.includes('Robinhood (free): 52,000 (no daily cap)'), 'free node usage shown without a cap');
assert(usage.includes('QuickNode (checks): 11,500 of 14,000 ⚠️') && usage.includes('at 82% of today'), '80%+ shows ⚠️ and a warning');
assert(usage.includes('Alchemy (scan): 30,000 of 30,000 ❌') && usage.includes('paused until midnight UTC'), 'used up shows ❌ and says the job is paused');

// Funnel: where trades dropped out, in plain words.
const fun = formatPlainHourly({ ...base, funnel: {
  tradesRead: 1240, noPool: 30, noPartner: 900, noUsdPrice: 10, smallerThanFees: 277, found: 23,
  belowCheckBar: 18, checkBarUsd: 0.5, notVetted: 3, sentToCheck: 2,
  skipped: [['another check was running', 1]],
} });
console.log('----- funnel -----\n' + fun.split('What happened')[1]?.split('Price differences found')[0] + '------------------');
assert(fun.includes('Trades read from the live feed: 1,240'), 'funnel: trades read');
assert(fun.includes('900 no second trading spot with $25k+ to compare'), 'funnel: depth filter drop in plain words');
assert(fun.includes('277 price difference smaller than the fees'), 'funnel: fees drop');
assert(fun.includes('18 estimated gain under $0.50'), 'funnel: check bar drop');
assert(fun.includes('Sent to be checked: 2') && fun.includes('1 not checked: another check was running'), 'funnel: checker skips listed');
assert(fun.length < 4000, 'still fits one Telegram message');
