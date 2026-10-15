// Tests for the loop results on the status page (Oct 15):
//   - LoopTrader.peekHour reads the hour's numbers WITHOUT resetting them
//     (takeHour still resets, and is the only call that does)
//   - loopLogLine: the one plain "[loop] hour..." log line
//   - deploy/status-report.js loopTradeLines: parses those lines for the page
//   - the Telegram hourly report puts the loop block before the rival section
import { join } from 'path';
import { LoopEnv } from '../core/loopFinder';
import { LoopTrader, loopConfigFromEnv, LoopTrade, LoopCheckResult, LoopHour } from '../core/loopTrader';
import { loopLogLine, formatLoopHour } from '../core/loopReport';
import { formatPlainHourly, PlainHourlyInput } from '../core/telegramFormatter';
import type { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Same tiny 3-pool loop setup as the other loop tests.
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1);
let clock = 9_000_000;
const E18 = 10n ** 18n;
function v2(addr: number, tA: string, tB: string, rA: number, rB: number): PoolState {
  return { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
    reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n,
    feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: clock };
}
const env: LoopEnv = {
  decimalsOf: () => 18, usdOf: (t) => (t.toLowerCase() === W ? 1 : null), depthUsd: () => 1_000_000,
  gasUsd: (hops) => 0.01 * hops, isTradable: () => true, now: () => clock,
};
const tick = () => new Promise<void>((r) => setImmediate(r));
const loopPools = (base: number) => [v2(base, W, A(base + 100), 1_000, 2_000), v2(base + 1, A(base + 100), A(base + 101), 2_000, 2_000), v2(base + 2, A(base + 101), W, 1_000, 1_300)];

// eslint-disable-next-line @typescript-eslint/no-var-requires
const status = require(join(__dirname, '..', '..', 'deploy', 'status-report.js'));

(async () => {
  // -------------------------------------------------------------------------
  // peekHour does not reset; takeHour does.
  // -------------------------------------------------------------------------
  let peeked: LoopHour;
  {
    const result: LoopCheckResult = { status: 'profit', profit: E18 / 10n, timing: 'latest' };
    const t = new LoopTrader(loopConfigFromEnv({ LOOP_TRADER: '1' }), {
      env, bases: [W], symbolOf: (x) => (x === W ? 'WETH' : 'T' + parseInt(x.slice(-4), 16)), decimalsOf: () => 18,
      canPracticeTest: () => true, canCheckNow: () => true,
      runCheck: async (_t: LoopTrade) => result,
      fix: { modelVsCheck: true }, noteGas: () => {},
    });
    clock += 10_000;
    t.onUpdate(loopPools(200));
    await tick();
    peeked = t.peekHour();
    const again = t.peekHour();
    assert(peeked.found === 1 && peeked.checked === 1 && peeked.wouldMake === 1, 'peekHour: sees the loop found and checked this hour');
    assert(again.found === 1 && again.checked === 1, 'peekHour twice: numbers not reset');
    const taken = t.takeHour();
    assert(taken.found === 1 && taken.checked === 1, 'takeHour after peek: same numbers (peek reset nothing)');
    assert(t.takeHour().found === 0 && t.peekHour().found === 0, 'takeHour resets: next hour starts at 0');
  }

  // -------------------------------------------------------------------------
  // loopLogLine: one plain line, same numbers as the Telegram block.
  // -------------------------------------------------------------------------
  {
    const line = loopLogLine(peeked, 5, 'hour');
    assert(line.startsWith('[loop] hour: found 1, best $') && /checked 1, would make 1 \(\$\d+\.\d\d\), lost 0, wouldn't go through 0, can't run 0, by length 3p 1 4p 0 5p 0/.test(line), `log line numbers (${line})`);
    assert(line.includes(' | model vs check (profit before gas, by timing): latest 1: model said $'), 'log line carries the model vs check part');
    assert(!line.includes('\n') && !/<[a-z/]/.test(line), 'log line: one line, no HTML');
    const tg = formatLoopHour(peeked, 5);
    assert(tg.includes('Loop trades: found 1,'), 'Telegram block still built from the same numbers');
    const so = loopLogLine(peeked, 3, 'hour so far (15 min)');
    assert(so.startsWith('[loop] hour so far (15 min): ') && /by length 3p 1( |$)/.test(so) && !so.includes('4p'), 'so-far line: only searched lengths listed');
  }

  // -------------------------------------------------------------------------
  // Status page: loopTradeLines.
  // -------------------------------------------------------------------------
  {
    const hourL = "[loop] hour: found 505, best $8.87, checked 39, would make 1 ($0.14), lost 37, wouldn't go through 1, can't run 0, by length 3p 115 4p 63 5p 327";
    const soL = "[loop] hour so far (15 min): found 120, best $2.10, checked 9, would make 0 ($0.00), lost 9, wouldn't go through 0, can't run 0, by length 3p 30 4p 20 5p 70";
    const noise = '[loop] WETH/T1/WETH model $0.40 after gas on $500 (3 pools): queued for a practice check';

    const none: string[] = status.loopTradeLines(['[mem] rss 1 MB', noise]);
    assert(none.length === 1 && /no loop results yet \(loops off/.test(none[0]), `nothing logged: "no loop results yet" (${none[0]})`);
    const starting: string[] = status.loopTradeLines(['[loop] loop trader ON (practice only, never sends): 3-5 pools']);
    assert(starting.length === 1 && /loop trader on, first numbers within 15 min/.test(starting[0]), 'trader on, no summary yet');

    const both: string[] = status.loopTradeLines([hourL, noise, soL, noise]);
    assert(both.length === 2 && both[0] === '- Loop trades (this hour so far, 15 min): ' + soL.replace(/^\[loop\] hour so far \(15 min\): /, ''), `so-far line shown first (${both[0]})`);
    assert(both[1] === '- Loop trades (last full hour): ' + hourL.replace(/^\[loop\] hour: /, ''), `full hour line (${both[1]})`);

    const stale: string[] = status.loopTradeLines([soL, noise, hourL]);
    assert(stale.length === 1 && /^- Loop trades \(last full hour\): found 505/.test(stale[0]), 'so-far line older than the hour line: not shown (it is the hour before)');
    const onlySo: string[] = status.loopTradeLines([soL]);
    assert(onlySo.length === 1 && /^- Loop trades \(this hour so far, 15 min\): found 120/.test(onlySo[0]), 'only a so-far line (first hour): shown alone');
    const two: string[] = status.loopTradeLines([hourL.replace('505', '1'), hourL]);
    assert(two.length === 1 && /found 505/.test(two[0]), 'latest full hour line wins');
  }

  // -------------------------------------------------------------------------
  // Telegram hourly: loop block now comes before the rival bots section.
  // -------------------------------------------------------------------------
  {
    const input: PlainHourlyInput = {
      windowLabel: '10:00 to 11:00', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 2,
      pricesFrom: 'free', freeNodeBusy: 0, differencesFound: 0,
      checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0 },
      checksAvailable: true,
      earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
      reactionMs: { typical: null, slowest5pct: null },
      rivalWins: { trades: 0, botsKnown: 2 } as PlainHourlyInput['rivalWins'],
      research: 'RESEARCH BLOCK',
      loops: '<b>Loop trades</b> LOOP BLOCK',
      topDifferences: [],
    } as PlainHourlyInput;
    const msg = formatPlainHourly(input);
    const loopAt = msg.indexOf('LOOP BLOCK'), rivalAt = msg.indexOf('What other bots did'), resAt = msg.indexOf('RESEARCH BLOCK');
    assert(loopAt > 0 && rivalAt > loopAt && resAt > loopAt, 'Telegram: loop block before rival bots and research blocks');
  }
})();
