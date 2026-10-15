import { readOutlierConfig, isOutlier, confirmOutlier, withDeadline } from '../core/outlierGuard';
import type { SimResult } from '../execution/simulator';

// ============================================================================
// Outlier guard (Oct 15): the $785 USDG/ORBIO gap.
//   1. Settings read safely, guard on by default, OUTLIER_GUARD=0 turns it off.
//   2. Normal wins ($0.10 to $20) are never outliers, whatever their size.
//   3. Over $50, or over 2% of the trade (and over $20), is an outlier.
//   4. The ORBIO case: profit paid in ORBIO is refused without even checking.
//   5. USDG/WETH outliers pass only if a second node agrees at full and half size.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const ORBIO = '0x00000000000000000000000000000000000000b9'; // stand-in address
const anchors = [USDG, WETH];

// A pretend second node: answers by start amount from a table, counting calls.
function fakeSim(answers: (amt: bigint) => SimResult) {
  const calls: bigint[] = [];
  return { calls, simulate: async (amt: bigint) => { calls.push(amt); return answers(amt); } };
}
const profit = (p: bigint): SimResult => ({ status: 'profit', profit: p });

async function main() {
  // 1. Settings
  const d = readOutlierConfig({});
  assert(d.on && d.maxUsd === 50 && d.maxPct === 2 && d.minUsd === 20, 'defaults: on, $50, 2%, never under $20');
  assert(!readOutlierConfig({ OUTLIER_GUARD: '0' }).on && !readOutlierConfig({ OUTLIER_GUARD: 'off' }).on, 'OUTLIER_GUARD=0/off turns it off');
  assert(readOutlierConfig({ OUTLIER_GUARD: '1' }).on && readOutlierConfig({ OUTLIER_GUARD: '' }).on, 'OUTLIER_GUARD=1 or empty keeps it on');
  const c = readOutlierConfig({ OUTLIER_MAX_USD: '100', OUTLIER_MAX_PCT: '5', OUTLIER_MIN_USD: 'junk' });
  assert(c.maxUsd === 100 && c.maxPct === 5 && c.minUsd === 20, 'settings can be changed; junk falls back to the default');

  // 2. Normal wins untouched
  assert(!isOutlier(0.10, 300, d) && !isOutlier(5, 300, d) && !isOutlier(20, 300, d), '$0.10, $5, $20 on a $300 trade: not outliers');
  assert(!isOutlier(20, 50, d), '$20 on $50 (40%) is still not an outlier (under the $20 floor)');
  assert(!isOutlier(19.99, 0, d), 'small win with unknown size is not an outlier');
  assert(!isOutlier(30, 2_000, d) && !isOutlier(50, 20_000, d), '$30 on $2,000 (1.5%) and $50 on $20,000: not outliers');

  // 3. Outliers
  assert(isOutlier(784.95, 20_000, d), 'the ORBIO gap ($785 on $20,000) is an outlier');
  assert(isOutlier(50.01, 1_000_000, d), 'over $50 is an outlier whatever the size');
  assert(isOutlier(25, 1_000, d), '$25 on $1,000 (2.5%) is an outlier');
  assert(isOutlier(NaN, 1_000, d) && isOutlier(25, 0, d), 'broken profit, or $20+ with no size: outlier');
  assert(!isOutlier(784.95, 20_000, readOutlierConfig({ OUTLIER_GUARD: '0' })), 'guard off: nothing is an outlier');

  // 4. ORBIO case: profit coin is ORBIO -> refused, no extra checks spent
  const s4 = fakeSim(() => profit(10n ** 18n));
  const v4 = await confirmOutlier({ tokenIn: ORBIO, anchors, amountIn: 10n ** 20n, firstProfit: 10n ** 18n, simulate: s4.simulate });
  assert(!v4.ok && s4.calls.length === 0, 'profit paid in ORBIO: refused without running any check');
  assert(!v4.ok && 'reason' in v4 && /not trusted/.test(v4.reason), 'reason says the price is not trusted');

  // 5. USDG outliers
  const amt = 20_000n * 10n ** 6n, first = 600n * 10n ** 6n; // $20,000 in, $600 first profit
  // Real gap: second node agrees, half size gives 75%.
  const real = fakeSim((a) => profit(a === amt ? 590n * 10n ** 6n : 450n * 10n ** 6n));
  const vReal = await confirmOutlier({ tokenIn: USDG, anchors, amountIn: amt, firstProfit: first, simulate: real.simulate });
  assert(vReal.ok && real.calls.length === 2 && real.calls[1] === amt / 2n, 'real USDG gap: two checks (full, then half) and it passes');
  // Second node disagrees (loss).
  const v5a = await confirmOutlier({ tokenIn: USDG, anchors, amountIn: amt, firstProfit: first, simulate: fakeSim(() => ({ status: 'loss' })).simulate });
  assert(!v5a.ok, 'second node says loss: refused');
  // Second node shows only 30% of the first profit.
  const v5b = await confirmOutlier({ tokenIn: WETH, anchors, amountIn: amt, firstProfit: first, simulate: fakeSim(() => profit(180n * 10n ** 6n)).simulate });
  assert(!v5b.ok, 'second node shows only 30% of the profit: refused');
  // Same profit at half size (a fixed fake amount, not a price gap).
  const v5c = await confirmOutlier({ tokenIn: USDG, anchors, amountIn: amt, firstProfit: first, simulate: fakeSim(() => profit(first)).simulate });
  assert(!v5c.ok && 'reason' in v5c && /half-size/.test(v5c.reason), 'same profit at half size: refused (does not scale like a real gap)');
  // Half size collapses to almost nothing.
  const v5d = await confirmOutlier({ tokenIn: USDG, anchors, amountIn: amt, firstProfit: first, simulate: fakeSim((a) => profit(a === amt ? first : 10n)).simulate });
  assert(!v5d.ok, 'half size makes almost nothing: refused');
  // Node busy: fails closed.
  const v5e = await confirmOutlier({ tokenIn: USDG, anchors, amountIn: amt, firstProfit: first, simulate: fakeSim(() => ({ status: 'rate_limited', reason: '429' })).simulate });
  assert(!v5e.ok, 'second node busy (rate limited): refused, never sent unchecked');
  // Case of the anchor address does not matter.
  const vCase = await confirmOutlier({ tokenIn: USDG.toLowerCase(), anchors, amountIn: amt, firstProfit: first, simulate: real.simulate });
  assert(vCase.ok, 'anchor match ignores upper/lower case');

  // Deadline: a second check that never answers counts as not confirmed (fail closed).
  const t0 = Date.now();
  const vSlow = await withDeadline(new Promise<never>(() => {}), 50);
  assert(!vSlow.ok && 'reason' in vSlow && /took over 50 ms/.test(vSlow.reason) && Date.now() - t0 < 1000, 'second check that never answers: refused after the deadline');
  const vErr = await withDeadline(Promise.reject(new Error('boom')), 50);
  assert(!vErr.ok && 'reason' in vErr && /boom/.test(vErr.reason), 'second check that throws: refused');
  const vFast = await withDeadline(Promise.resolve({ ok: true as const, detail: 'fine' }), 50);
  assert(vFast.ok, 'second check that answers in time: its answer is kept');
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
