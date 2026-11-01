import { PoolCache } from '../core/poolCache';
import { computeAmountOut } from '../core/dexMath';
import { PoolState } from '../core/types';

// ============================================================================
// ZERO GUARD (Nov 1, MATH_ZERO_GUARD). Plain English: "Division by zero" in
// the live log (a few a day) is JavaScript's own error for a whole-number
// (BigInt) division by 0. The trade-follow maths hit it on pools with no
// price yet (sqrtPriceX96 0), no money at the current price (liquidity 0),
// or an empty V2 side, and the error escaped the feed trade ("unhandled
// rejection"). Worse, a liquidity-0 pool with a bigger trade got a predicted
// price of 0 written into the pool copy. Checks:
//   - with the guard (default): no throw, no price-0 prediction, the pool is
//     simply "not predicted" (returned as it was) / not quoted (null);
//   - normal pools: exactly the same answers with the guard on and off;
//   - MATH_ZERO_GUARD=0: the old behaviour (the same throws as before).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const base = { chain: 'robinhood', poolAddress: '0x' + '01'.repeat(20), tokenA: '0x' + 'aa'.repeat(20), tokenB: '0x' + 'bb'.repeat(20), feeBps: 30, lastUpdatedMs: 0 } as const;
const v3 = (sqrtPriceX96: bigint, liquidity: bigint) => ({ ...base, dex: 'uniswap-v3', poolType: 'v3', sqrtPriceX96, liquidity }) as unknown as PoolState;
const v2 = (reserveA: bigint, reserveB: bigint) => ({ ...base, dex: 'uniswap-v2', poolType: 'v2', reserveA, reserveB }) as unknown as PoolState;
const Q96 = 2n ** 96n;
const show = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

function run(env: string | undefined) {
  if (env === undefined) delete process.env.MATH_ZERO_GUARD; else process.env.MATH_ZERO_GUARD = env;
  const c = new PoolCache();
  const out: string[] = [];
  let throws = 0, zeroPrice = 0;
  const edge = [v3(0n, 0n), v3(0n, 10n ** 18n), v3(1n, 0n), v3(1n, 1n), v3(1n, 10n ** 18n), v3(Q96, 0n), v2(0n, 0n), v2(0n, 10n ** 18n), v2(10n ** 18n, 0n), v2(1n, 0n)];
  for (const p of edge) for (const dir of [true, false]) for (const amt of [1n, 10n ** 15n]) {
    try { const r = c.predictPostTradeState(p, dir, amt); if (r.poolType === 'v3' && r.sqrtPriceX96 === 0n && p.sqrtPriceX96 !== 0n) zeroPrice++; } catch { throws++; }
    try { computeAmountOut(p, dir, amt); } catch { throws++; }
  }
  // Normal pools: a spread of real-looking states and trade sizes.
  for (let i = 1; i <= 40; i++) {
    const sp = (Q96 * BigInt(500 + i * 37)) / 1000n, L = 10n ** BigInt(15 + (i % 8)), ra = 10n ** BigInt(18 + (i % 5)), rb = 10n ** BigInt(6 + (i % 7)) * BigInt(i);
    for (const p of [v3(sp, L), v2(ra, rb)]) for (const dir of [true, false]) for (const amt of [10n ** 6n, 10n ** 12n, 10n ** 18n * BigInt(i)]) {
      out.push(show(c.predictPostTradeState(p, dir, amt)) + '|' + show(computeAmountOut(p, dir, amt)));
    }
  }
  return { throws, zeroPrice, normal: out };
}

const on = run(undefined);
const off = run('0');
assert(on.throws === 0, `guard on: no "Division by zero" on empty pools (${on.throws} throws)`);
assert(on.zeroPrice === 0, `guard on: no price-0 prediction written for a liquidity-0 pool (${on.zeroPrice})`);
assert(off.throws > 0 && off.zeroPrice > 0, `MATH_ZERO_GUARD=0: the old behaviour is still there (${off.throws} throws, ${off.zeroPrice} price-0 predictions)`);
assert(on.normal.length === 480 && on.normal.every((x, i) => x === off.normal[i]), `normal pools: all ${on.normal.length} predictions and quotes the same with the guard on and off`);
{
  const c = new PoolCache();
  const p = v3(Q96, 0n);
  delete process.env.MATH_ZERO_GUARD;
  assert(c.predictPostTradeState(p, true, 10n ** 15n) === p, 'guard on: "no prediction" = the same pool object back (callers already read that as "nothing to apply")');
}
delete process.env.MATH_ZERO_GUARD;
