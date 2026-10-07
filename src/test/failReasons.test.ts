import { classifyFailReason, FailTally, FAIL_GROUP_LABEL } from '../core/failReasons';
import { formatPlainHourly } from '../core/telegramFormatter';

// Failed real-chain checks are sorted into plain-English groups for the
// hourly Telegram report, and the bug-on-our-side group is flagged.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// --- classification -------------------------------------------------------
assert(classifyFailReason('UniswapV2: K') === 'tax', 'V2 K check = coin takes a cut');
assert(classifyFailReason('IIA') === 'tax', 'V3 IIA = coin takes a cut');
assert(classifyFailReason('TokenBalanceDropped(0xabc)') === 'tax', 'middle coin shrank = coin takes a cut');
assert(classifyFailReason('TransferHelper: TRANSFER_FAILED') === 'transfer', 'transfer failed = money could not be moved');
assert(classifyFailReason('STF') === 'transfer', 'STF = money could not be moved');
assert(classifyFailReason('TF') === 'transfer', 'TF = money could not be moved (lender short)');
assert(classifyFailReason('TransferFailed()') === 'transfer', 'our TransferFailed = money could not be moved');
assert(classifyFailReason('L') === 'transfer', 'L = lender had no active liquidity');
assert(classifyFailReason('ERC20: sender is blacklisted') === 'blocked', 'explicit blacklist = coin blocks trading');
assert(classifyFailReason('BadRoute()') === 'ours', 'BadRoute = our bug');
assert(classifyFailReason('SPL') === 'ours', 'bad price limit = our bug');
assert(classifyFailReason('UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT') === 'stale', 'output short = old price info');
assert(classifyFailReason('implausible profit') === 'stale', 'too-good profit = bad price info');
assert(classifyFailReason('reverted without data') === 'silent', 'no data = no reason given');
assert(classifyFailReason('') === 'silent', 'empty = no reason given');
assert(classifyFailReason('revert 0x12345678') === 'other', 'unknown error = other');
assert(classifyFailReason('same as before') === 'other', 'lowercase words never match the short codes');

// --- tally ----------------------------------------------------------------
const t = new FailTally();
['UniswapV2: K', 'UniswapV2: K', 'IIA', 'BadRoute()', 'revert 0x12345678'].forEach((r) => t.add(r));
const plain = t.plain();
assert(plain[0][0] === FAIL_GROUP_LABEL.tax && plain[0][1] === 3, 'biggest group first with its count');
assert(t.total() === 5, 'total counts every failure');
assert(t.topRaw(1)[0][0] === 'UniswapV2: K' && t.topRaw(1)[0][1] === 2, 'raw reasons counted too');
t.clear();
assert(t.total() === 0 && t.plain().length === 0, 'clear resets for the next hour');

// --- Telegram ----------------------------------------------------------------
const base = {
  windowLabel: '05:44 to 06:44', live: false, feedOk: true, feedReconnects: 0, pairs: 60, spots: 276,
  pricesFrom: 'free' as const, freeNodeBusy: 0, differencesFound: 10, checksAvailable: true,
  earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
  reactionMs: { typical: 5, slowest5pct: 10 }, topDifferences: [],
};
const t2 = new FailTally();
['UniswapV2: K', 'UniswapV2: K', 'BadRoute()'].forEach((r) => t2.add(r));
const msg = formatPlainHourly({ ...base, checks: { done: 3, makeMoney: 0, loseMoney: 0, wouldFail: 3, nodeBusy: 0, failReasons: t2.plain() } });
assert(msg.includes('Why:') && msg.includes('coin takes a cut when moved (skip these coins): 2'), 'Telegram lists why trades would not go through');
assert(/built the trade wrong\. Tell me/.test(msg), 'a bug on our side is flagged under needs attention');
const none = formatPlainHourly({ ...base, checks: { done: 2, makeMoney: 0, loseMoney: 2, wouldFail: 0, nodeBusy: 0, failReasons: [] } });
assert(!none.includes('Why:'), 'no reasons section when nothing failed');
