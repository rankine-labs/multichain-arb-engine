import { readMinExecNetUsd, DEFAULT_MIN_EXEC_NET_USD, MIN_NET_PROFIT_USD } from '../core/types';
import { calculateAllInProfit } from '../core/profitCalculator';
import { scoreOpportunity, shouldPreArm } from '../core/opportunityScorer';
import { OwnMoneyBook, useOwnMoney, OWN_MONEY_CUSHION } from '../core/ownMoney';

// ============================================================================
// Send minimum ($0.10, was $20) and own-money funding (Oct 11).
//   1. The setting reads safely (bad values fall back to $0.10).
//   2. $0.09 is refused, $0.10 and $0.11 pass -- the line sits exactly at the minimum.
//   3. The score no longer hides a ~$5 bar on Robinhood.
//   4. Own money is used only when the trade fits under BOTH the $2,000 limit
//      and what the contract really holds (live); otherwise the trade borrows.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  // 1. Setting
  assert(DEFAULT_MIN_EXEC_NET_USD === 0.10 && readMinExecNetUsd(undefined) === 0.10, 'default send minimum is $0.10');
  assert(readMinExecNetUsd('0.5') === 0.5 && readMinExecNetUsd('20') === 20, 'MIN_EXEC_NET_USD can raise it');
  assert(readMinExecNetUsd('') === 0.10 && readMinExecNetUsd('abc') === 0.10 && readMinExecNetUsd('-1') === 0.10 && readMinExecNetUsd('0') === 0.10, 'empty, junk, negative or zero -> $0.10');
  assert(MIN_NET_PROFIT_USD === 0.10, 'the bot uses $0.10 when the setting is not set (tests run without it)');

  // 2. The line: net after gas, loan fee and safety haircut (all 0 here so net = gross).
  const net = (gross: number) => calculateAllInProfit({ optimalTradeSizeUsd: 100, grossProfitUsd: gross }, {
    gasPriceUsd: 0, dexFeeBps: { buy: 0, sell: 0 }, flashLoanFeeBps: 0, usingFlashLoan: false, safetyMarginPct: 0,
  });
  assert(!net(0.09).qualifies, '$0.09 net: not sent');
  assert(net(0.10).qualifies, '$0.10 net: sent (exactly on the line)');
  assert(net(0.11).qualifies, '$0.11 net: sent');
  assert(net(5).qualifies && net(19.99).qualifies, '$5 and $19.99: sent (all refused under the old $20 rule)');
  // Costs still come off first: $0.12 gross with 2.4 cents gas is under the line.
  const withGas = calculateAllInProfit({ optimalTradeSizeUsd: 100, grossProfitUsd: 0.12 }, {
    gasPriceUsd: 0.024, dexFeeBps: { buy: 30, sell: 30 }, flashLoanFeeBps: 0, usingFlashLoan: false, safetyMarginPct: 0.15,
  });
  assert(!withGas.qualifies && withGas.conservativeNetProfitUsd < 0.10, 'gas and safety haircut are taken off before the $0.10 test');
  // Loan fee counts: $0.20 gross on a $2,000 loan at 0.01% ($0.20 fee) is nothing.
  const withLoan = calculateAllInProfit({ optimalTradeSizeUsd: 2_000, grossProfitUsd: 0.20 }, {
    gasPriceUsd: 0, dexFeeBps: { buy: 0, sell: 0 }, flashLoanFeeBps: 1, usingFlashLoan: true, safetyMarginPct: 0,
  });
  assert(!withLoan.qualifies, 'loan fee is taken off before the $0.10 test');

  // 3. Score: no hidden bar.
  const score = (n: number) => scoreOpportunity({ conservativeNetProfitUsd: n, stateType: 'SEQUENCED', chain: 'robinhood' });
  assert(!shouldPreArm(score(0.09)), 'score: $0.09 blocked');
  assert(shouldPreArm(score(0.10)) && shouldPreArm(score(3)), 'score: $0.10 and $3 pass (the old 40-point gate needed ~$5)');
  assert(shouldPreArm(scoreOpportunity({ conservativeNetProfitUsd: 0.5, stateType: 'SPECULATIVE', chain: 'monad' })), 'same rule on other chains');

  // 4a. Own money or loan.
  const base = { ownMoneyOn: true, ownMaxUsd: 2_000, noBalanceSlot: false };
  assert(useOwnMoney({ ...base, tradeSizeUsd: 10, ownAvailableUsd: 980 }), '$10 trade, $980 usable: own money');
  assert(!useOwnMoney({ ...base, tradeSizeUsd: 1_800, ownAvailableUsd: 980 }), '$1,800 trade, $980 usable: borrow (never pretend we hold $1,800)');
  assert(useOwnMoney({ ...base, tradeSizeUsd: 1_800, ownAvailableUsd: Infinity }), 'practice: $1,800 still own money (old assumption kept)');
  assert(!useOwnMoney({ ...base, tradeSizeUsd: 2_500, ownAvailableUsd: Infinity }), '$2,500 trade: over the $2,000 limit, borrow');
  assert(!useOwnMoney({ ...base, tradeSizeUsd: 10, ownAvailableUsd: 980, noBalanceSlot: true }), 'coin the practice checker cannot fund: borrow');
  assert(!useOwnMoney({ ...base, ownMoneyOn: false, tradeSizeUsd: 10, ownAvailableUsd: 980 }), 'own money switched off: borrow');

  // 4b. Real balances (live).
  const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  let live = false;
  const book = new OwnMoneyBook(() => live);
  assert(book.availableUsd(USDG, 1, 6) === Infinity && book.covers(USDG, 10n ** 30n), 'practice: no balance limit, nothing to check');
  live = true;
  assert(book.availableUsd(USDG, 1, 6) === 0 && !book.covers(USDG, 1n), 'live before the first read: no own money (every trade borrows)');
  // Fake node: the contract holds 1,000 USDG (6 decimals).
  const calls: string[] = [];
  await book.refresh(async (cs) => { calls.push(...cs.map((c) => c.data)); return cs.map(() => '0x' + (1_000n * 10n ** 6n).toString(16).padStart(64, '0')); }, '0x00000000000000000000000000000000000000e1', [USDG]);
  assert(calls[0].startsWith('0x70a08231') && calls[0].endsWith('e1'), 'reads balanceOf(the trade contract)');
  assert(Math.abs(book.availableUsd(USDG, 1, 6) - 1_000 * OWN_MONEY_CUSHION) < 1e-9, 'live: $1,000 held -> $980 usable (2% cushion)');
  assert(book.covers(USDG, 1_000n * 10n ** 6n) && !book.covers(USDG, 1_000n * 10n ** 6n + 1n), 'final check before sending: exact amount held or refused');
  await book.refresh(async (cs) => cs.map(() => null), '0x00000000000000000000000000000000000000e1', [USDG]);
  assert(book.availableUsd(USDG, 1, 6) === 0, 'unreadable balance counts as zero (borrow rather than fail)');
}
main();
