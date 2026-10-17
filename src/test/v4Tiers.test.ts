// Tests for the Uniswap V4 fee settings the bot looks up (config/v4Tiers.ts)
// and the "practice only" rule for non-standard pools.
//
// What must hold:
//   - the 4 standard settings come first and stay live-tradable;
//   - the extra settings really reproduce the pool ids of the real pools in
//     the Oct 16 workbook (so the bot now finds those exact pools);
//   - RH_V4_EXTRA_TIERS=0 restores the old 4-setting lookup;
//   - a hook-free pool at a non-standard setting is practice only (live send
//     and "could earn live" leave it out), hooked or standard pools are not
//     affected by this rule.
import { v4PoolId } from '../core/poolResolver';
import { STANDARD_V4_TIERS, EXTRA_V4_TIERS, V4_LOOKUP_TIERS, buildLookupTiers, parseTiers, isStandardV4Tier, practiceOnlyReason } from '../config/v4Tiers';
import { realisticVerdict } from '../core/realisticPnl';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const lc = (a: string) => a.toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const MSTR = '0xec262a75e413fAfD0dF80480274532C79D42da09';
const sorted = (a: string, b: string): [string, string] => (lc(a) < lc(b) ? [a, b] : [b, a]);

// 1) The list.
assert(JSON.stringify(V4_LOOKUP_TIERS.slice(0, 4)) === JSON.stringify(STANDARD_V4_TIERS), 'the 4 standard settings come first');
assert(V4_LOOKUP_TIERS.length === 4 + EXTRA_V4_TIERS.length, `extra settings included by default (${V4_LOOKUP_TIERS.length})`);
assert(new Set(V4_LOOKUP_TIERS.map(([f, t]) => `${f}:${t}`)).size === V4_LOOKUP_TIERS.length, 'no duplicates');
assert(buildLookupTiers({ RH_V4_EXTRA_TIERS: '0' }).length === 4, 'RH_V4_EXTRA_TIERS=0: only the 4 standard settings');
assert(JSON.stringify(parseTiers('750:15, 4000:80')) === JSON.stringify([[750, 15], [4000, 80]]), 'RH_V4_MORE_TIERS parsed');
assert(parseTiers('abc,1000000:1,500:0,').length === 0, 'bad extra settings skipped');
assert(buildLookupTiers({ RH_V4_MORE_TIERS: '750:15,500:10' }).length === V4_LOOKUP_TIERS.length + 1, 'extra setting added once, duplicate of a standard one ignored');

// 2) Real workbook pools: the fingerprints match exactly.
const has = (fee: number, ts: number) => V4_LOOKUP_TIERS.some(([f, t]) => f === fee && t === ts);
const [s0, s1] = sorted(SPY, USDG);
assert(has(500, 5) && lc(v4PoolId(s0, s1, 500, 5)) === '0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907', 'SPY/USDG 0.05% spacing 5 (the $980k pool) is found');
assert(has(460, 9) && lc(v4PoolId(ZERO, USDG, 460, 9)) === '0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32', 'ETH/USDG 0.046% spacing 9 (the $730k pool) is found');
const [m0, m1] = sorted(MSTR, USDG);
assert(has(2500, 25) && lc(v4PoolId(m0, m1, 2500, 25)) === '0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe', 'MSTR/USDG 0.25% spacing 25 (the $1.4M pool) is found');
assert(has(2400, 24) && lc(v4PoolId(m0, m1, 2400, 24)) === '0xc105b8300ff65d750a0e4e63c7a879e20504069b770713464a5315e797735326', 'MSTR/USDG 0.24% spacing 24 is found');

// 3) Practice-only rule.
assert(isStandardV4Tier(500, 10) && !isStandardV4Tier(500, 5), 'standard check');
const OFF = { RH_V4_EXTRA_LIVE: '0' };
assert(practiceOnlyReason({ v4: { fee: 500, tickSpacing: 5 } }, {}) === null, 'go-live (Oct 16): non-standard hook-free pool is live-tradable by default');
assert(practiceOnlyReason({ v4: { fee: 500, tickSpacing: 10 } }, OFF) === null, 'standard hook-free pool: always live-tradable');
assert(/practice only/.test(practiceOnlyReason({ v4: { fee: 500, tickSpacing: 5 } }, OFF) ?? ''), 'RH_V4_EXTRA_LIVE=0: non-standard hook-free pool is practice only');
assert(/practice only/.test(practiceOnlyReason({ v4: { fee: 460, tickSpacing: 9, hooks: ZERO } }, OFF) ?? ''), 'zero hook address counts as hook-free');
assert(practiceOnlyReason({ v4: { fee: 0x800000, tickSpacing: 9, hooks: '0x1111111111111111111111111111111111111111' } }, OFF) === null, 'hooked pools are gated by their venue, not by this rule');
assert(practiceOnlyReason({}, OFF) === null, 'not a V4 pool: not affected');

// 4) "Could earn live" leaves practice-only trades out, with their own reason.
const cfg = { startCoins: new Set([lc(USDG)]), ownMaxUsd: 2_000 };
assert(realisticVerdict({ startToken: USDG, sizeUsd: 100, notLive: 'practice only' }, cfg) === 'venue', 'practice-only pool: left out as "exchange not live yet"');
assert(realisticVerdict({ startToken: SPY, sizeUsd: 100, notLive: 'practice only' }, cfg) === 'otherCoin', 'start coin rule still checked first');
assert(realisticVerdict({ startToken: USDG, sizeUsd: 100 }, cfg) === 'ok', 'normal trade still counts');
