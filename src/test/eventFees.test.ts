import { parsePoolLogs, V4_SWAP_TOPIC, ALGEBRA_INTEGRAL_SWAP_TOPIC, V3_SWAP_TOPIC, RpcLog } from '../core/blockReader';
import { recordEventFee, eventFeePips, eventFeeCounts, setFeeFromEvents, isDynamicFeePool } from '../core/eventFees';
import { feePipsOf, computeAmountOut } from '../core/dexMath';
import { PoolState } from '../core/types';

// Fees seen in Swap events (Oct 13, FEE_FROM_EVENTS): parsed from V4 and
// Algebra Integral logs, stored per pool and direction, used while newer
// than the last fee read; switch off = old behaviour.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Hand-encoded 32-byte words (two's complement for negatives).
const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, '0');
const data = (...vs: bigint[]) => '0x' + vs.map(word).join('');
const PM = '0x' + '44'.repeat(20);
const ALG = '0x' + 'a1'.repeat(20);
const V4ID = '0x' + '9f'.repeat(32);
const SQRT = 79228162514264337593543950336n; // price 1
const topicAddr = (a: string) => '0x' + a.slice(2).padStart(64, '0');

let now = 5_000_000;
setFeeFromEvents(true, { maxAgeMs: 600_000, now: () => now });

// ---- V4 Swap: amount0, amount1, sqrtPriceX96, liquidity, tick, fee
const v4Log: RpcLog = {
  address: PM, topics: [V4_SWAP_TOPIC, V4ID, topicAddr('0x' + '01'.repeat(20))],
  data: data(-1000n, 990n, SQRT, 10n ** 18n, -5n, 4500n), blockNumber: '0x64', logIndex: '0x1',
};
const [v4u] = parsePoolLogs([v4Log], PM);
assert(!!v4u && v4u.kind === 'v4' && v4u.v4Fee === 4500 && v4u.zeroForOne === true && v4u.tick === -5, 'V4 Swap: fee 4500 pips read; amount0 < 0 (swapper paid token0) = zeroForOne');
const v4back = parsePoolLogs([{ ...v4Log, data: data(1000n, -990n, SQRT, 10n ** 18n, 0n, 2600n) }], PM)[0];
assert(v4back.v4Fee === 2600 && v4back.zeroForOne === false, 'V4 Swap other direction: fee 2600, oneForZero');
const v4junk = parsePoolLogs([{ ...v4Log, data: data(-1n, 1n, SQRT, 1n, 0n, 0x800000n) }], PM)[0];
assert(v4junk.v4Fee === undefined, 'V4 fee >= 100% (e.g. the dynamic flag value) ignored');

// ---- Algebra Integral Swap: amount0, amount1, price, liquidity, tick, overrideFee, pluginFee
const algLog: RpcLog = {
  address: ALG, topics: [ALGEBRA_INTEGRAL_SWAP_TOPIC, topicAddr('0x' + '02'.repeat(20)), topicAddr('0x' + '03'.repeat(20))],
  data: data(500n, -495n, SQRT, 10n ** 18n, 7n, 1200n, 300n), blockNumber: '0x65', logIndex: '0x2',
};
const [au] = parsePoolLogs([algLog], PM);
assert(!!au && au.kind === 'v3' && au.algebraFee?.override === 1200 && au.algebraFee?.plugin === 300 && au.zeroForOne === true, 'Algebra Integral Swap: overrideFee 1200 + pluginFee 300; amount0 > 0 (pool received token0) = zeroForOne');
const plainV3 = parsePoolLogs([{ ...algLog, topics: [V3_SWAP_TOPIC, algLog.topics[1], algLog.topics[2]], data: data(500n, -495n, SQRT, 10n ** 18n, 7n) }], PM)[0];
assert(plainV3.algebraFee === undefined && plainV3.v4Fee === undefined && plainV3.sqrtPriceX96 === SQRT, 'plain V3 Swap: price read as before, no fee fields');

// ---- Pools
const v4Pool = (): PoolState => ({
  chain: 'robinhood', dex: 'fables', poolAddress: V4ID, poolType: 'v3', tokenA: '0x' + '0a'.repeat(20), tokenB: '0x' + '0b'.repeat(20),
  sqrtPriceX96: SQRT, liquidity: 10n ** 20n, feeBps: 30, feePips: 3000, lastUpdatedBlock: 0, lastUpdatedMs: now,
  v4: { fee: 0x800000, tickSpacing: 60, native: false, poolManager: PM, stateView: PM, hooks: '0x' + '77'.repeat(20) },
});
const algPool = (): PoolState => ({
  chain: 'robinhood', dex: 'alandale', poolAddress: ALG, poolType: 'v3', variant: 'algebra', tokenA: '0x' + '0a'.repeat(20), tokenB: '0x' + '0b'.repeat(20),
  sqrtPriceX96: SQRT, liquidity: 10n ** 20n, feeBps: 5, feePips: 500, lastUpdatedBlock: 0, lastUpdatedMs: now,
});
assert(isDynamicFeePool(v4Pool()) && isDynamicFeePool(algPool()), 'Fables (hooked, flag) and Algebra count as changing-fee pools');

// Algebra: override + plugin used
const a = algPool();
a.feeReadMs = now - 1_000;
assert(recordEventFee(a, au, now) && a.observedFee?.z?.pips === 1500, 'Algebra: stored fee = override 1200 + plugin 300');
// One direction only on a non-hooked pool: the observed fee is used directly.
assert(feePipsOf(a) === 1500, 'observed fee newer than the globalState read: used by the swap maths (1500 instead of 500)');
// Fee read again later: the read wins.
a.feeReadMs = now + 1;
assert(feePipsOf(a) === 500, 'a fee read newer than the event: the read wins again');
a.feeReadMs = now - 1_000;
// pluginFee only: pool's own fee + plugin
const a2 = algPool();
recordEventFee(a2, { block: 102, zeroForOne: false, algebraFee: { override: 0, plugin: 250 } }, now);
assert(a2.observedFee?.o?.pips === 750, 'Algebra pluginFee only: own fee 500 + 250');
// 0/0: the swap paid the pool's own fee -> older override for that direction forgotten
recordEventFee(a2, { block: 103, zeroForOne: false, algebraFee: { override: 0, plugin: 0 } }, now);
assert(!a2.observedFee?.o && feePipsOf(a2) === 500, 'Algebra 0/0 fees: forget the old override, back to the read fee');

// V4 hooked (Fables): both directions -> the higher; one direction -> never below the source fee
const p = v4Pool();
recordEventFee(p, { ...v4u, v4Fee: 2000 }, now);
assert(eventFeePips(p, now) === 3000 && feePipsOf(p) === 3000, 'hooked V4, one direction seen lower (2000) than the source (3000): stays 3000 (other direction unknown)');
recordEventFee(p, { ...v4u, v4Fee: 4500 }, now);
assert(feePipsOf(p) === 4500, 'hooked V4, one direction seen higher (4500): 4500');
recordEventFee(p, { ...v4back, block: 101 }, now);
assert(feePipsOf(p) === 4500, 'both directions seen (4500, 2600): the higher, 4500');
const p2 = v4Pool();
recordEventFee(p2, { ...v4u, v4Fee: 2000 }, now); recordEventFee(p2, { ...v4back, v4Fee: 2200 }, now);
assert(feePipsOf(p2) === 2200, 'both directions seen below the guess (2000, 2200): real fee 2200 used instead of the 3000 guess');
// Price maths really uses it
const before = computeAmountOut(v4Pool(), true, 10n ** 15n)!;
const after = computeAmountOut(p2, true, 10n ** 15n)!;
assert(after > before, 'swap output improves when the real (lower) fee replaces the guess');

// Older event never replaces a newer one
const p3 = v4Pool();
recordEventFee(p3, { block: 200, zeroForOne: true, v4Fee: 2500 }, now);
assert(!recordEventFee(p3, { block: 150, zeroForOne: true, v4Fee: 100 }, now) && p3.observedFee?.z?.pips === 2500, 'an older event does not replace a newer one');

// Age limit
const p4 = algPool();
recordEventFee(p4, au, now);
now += 600_001;
assert(feePipsOf(p4) === 500, 'event fee older than 10 min: ignored');
now -= 600_001;

// Counts for the report
const fresh = v4Pool();
const counts = eventFeeCounts([p2, a, fresh, algPool()], now);
assert(counts.fromEvents === 2 && counts.waiting === 1, `report counts: ${counts.fromEvents} pools from events, ${counts.waiting} dynamic V4 pool waiting`);

// ---- Switch off = old behaviour
setFeeFromEvents(false);
assert(feePipsOf(p2) === 3000 && feePipsOf(a) === 500, 'FEE_FROM_EVENTS off: stored event fees ignored (old fees)');
const p5 = v4Pool();
assert(!recordEventFee(p5, v4u, now) && p5.observedFee === undefined, 'FEE_FROM_EVENTS off: nothing recorded');
assert(eventFeeCounts([p2], now).fromEvents === 0, 'off: report counts 0 pools from events');
setFeeFromEvents(true);
