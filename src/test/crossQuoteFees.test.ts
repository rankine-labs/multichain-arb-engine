// ============================================================================
// CROSS-QUOTE MONITOR: real fees and fresh depth
//
// Plain English:
//   The USDG-vs-ETH gap monitor used to (a) charge every V2-style pool 0.3%
//   even on exchanges that charge 0.25% or 0.2%, (b) store "30 bps" in every
//   pool record whatever the real fee, and (c) rank pools by how much money
//   they held at startup, never re-checking. This test proves:
//     - V2-style fees come from the exchange (PancakeSwap 0.25%, Ramses 0.2%)
//     - V3 fees are read from the pool; a failed read is flagged, not hidden
//     - the pool record's fee matches the fee used in the gap maths
//     - depth is re-read on a timer and the deepest pool can change
// ============================================================================

import { CrossQuoteMonitor, legFee } from '../core/crossQuoteMonitor';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const TOK = '0x00000000000000000000000000000000000000aa';  // sorts below both quotes -> token0
const P_CAKE = '0x00000000000000000000000000000000000000b1'; // TOK/USDG pancakeswap-v2 (0.25%)
const P_UNI3 = '0x00000000000000000000000000000000000000b2'; // TOK/WETH uniswap-v3 (fee read: 500 pips)
const P_RAM = '0x00000000000000000000000000000000000000b3';  // TOK/USDG ramses-v2 (0.2%)
const P_ODD = '0x00000000000000000000000000000000000000b4';  // TOK/WETH v3 whose fee() fails

// legFee rulebook.
assert(legFee('pancakeswap-v2', 'v2').feePct === 0.25 && legFee('pancakeswap-v2', 'v2').feeKnown, 'PancakeSwap V2 = 0.25%');
assert(legFee('ramses-v2', 'solidly').feePct === 0.2, 'Ramses V2 = 0.2%');
assert(legFee('uniswap-v2', 'v2').feePct === 0.3, 'Uniswap V2 = 0.3%');
assert(!legFee('mystery-swap', 'v2').feeKnown && legFee('mystery-swap', 'v2').feePct === 0.3, 'unknown exchange: 0.3% assumed AND flagged');
assert(legFee('uniswap-v3', 'v3', 0.05).feePct === 0.05 && legFee('uniswap-v3', 'v3', 0.05).feeKnown, 'V3 uses the fee read from the pool');
assert(!legFee('uniswap-v3', 'v3', undefined).feeKnown, 'V3 with an unreadable fee is flagged');

const w = (v: bigint) => v.toString(16).padStart(64, '0');
// Quote-side balances, changeable during the test.
const balances: Record<string, bigint> = {
  [P_CAKE]: 100_000n * 10n ** 6n,  // $100k USDG
  [P_RAM]: 20_000n * 10n ** 6n,    // $20k USDG
  [P_UNI3]: 30n * 10n ** 18n,      // 30 WETH
  [P_ODD]: 5n * 10n ** 18n,        // 5 WETH
};
let reads = 0;
async function callMany(calls: { target: string; data: string }[]) {
  return calls.map((c) => {
    const sel = c.data.slice(0, 10);
    if (sel === '0x70a08231') { reads++; return '0x' + w(balances['0x' + c.data.slice(-40)] ?? 0n); }
    if (sel === '0x313ce567') return '0x' + w(18n);
    if (sel === '0x95d89b41') return '0x' + w(32n) + w(3n) + Buffer.from('TOK').toString('hex').padEnd(64, '0');
    if (sel === '0xddca3f43') return c.target === P_UNI3 ? '0x' + w(500n) : null; // P_ODD: fee() fails
    if (sel === '0x0902f1ac') { // V2 getReserves (token0 = TOK): $200 each
      return '0x' + w(1_000n * 10n ** 18n) + w(200_000n * 10n ** 6n) + w(0n);
    }
    if (sel === '0x3850c7bd') { // V3 slot0: TOK priced at 0.05 WETH -> sqrt(0.05) * 2^96
      const sqrt = BigInt(Math.floor(Math.sqrt(0.05) * 2 ** 48)) * (1n << 48n);
      return '0x' + w(sqrt) + w(0n).repeat(6);
    }
    if (sel === '0x1a686502') return '0x' + w(10n ** 24n); // V3 liquidity
    return null;
  });
}

async function main() {
  let clock = 1_000;
  const m = new CrossQuoteMonitor(callMany, USDG, WETH, () => 4_000, () => clock, 10 * 60_000);
  const n = await m.setup([
    { dex: 'pancakeswap-v2', kind: 'v2', pool: P_CAKE, token0: TOK, token1: USDG },
    { dex: 'ramses-v2', kind: 'solidly', pool: P_RAM, token0: TOK, token1: USDG },
    { dex: 'uniswap-v3', kind: 'v3', pool: P_UNI3, token0: TOK, token1: WETH },
    { dex: 'odd-v3', kind: 'v3', pool: P_ODD, token0: TOK, token1: WETH },
  ]);
  assert(n === 1, 'token with USDG and WETH pools is watched');
  const legs = (m as any).legs.get(TOK) as any[];
  const byPool = (a: string) => legs.find((l) => l.pool.poolAddress === a);
  assert(byPool(P_CAKE).feePct === 0.25 && byPool(P_CAKE).pool.feeBps === 25, 'PancakeSwap leg: 0.25% in the maths AND 25 bps in the pool record (was 0.3% / 30)');
  assert(byPool(P_RAM).feePct === 0.2 && byPool(P_RAM).pool.feeBps === 20, 'Ramses V2 leg: 0.2% / 20 bps');
  assert(byPool(P_UNI3).feePct === 0.05 && byPool(P_UNI3).pool.feeBps === 5 && byPool(P_UNI3).pool.feePips === 500, 'Uniswap V3 leg: real 0.05% (500 pips)');
  assert(!byPool(P_ODD).feeKnown && m.unknownFeeLegs() === 1, 'V3 pool whose fee could not be read is flagged (1 unknown-fee leg)');
  assert(m.depthAgeMs() === 0, 'depth freshly read at setup');

  // Deepest USDG pool at setup: PancakeSwap ($100k vs $20k).
  const deepestUsdg = () => [...legs].filter((l) => l.quote === 'usdg').sort((a, b) => b.quoteUsd - a.quoteUsd)[0].pool.poolAddress;
  assert(deepestUsdg() === P_CAKE, 'at setup PancakeSwap is the deepest USDG pool');

  // Liquidity moves: PancakeSwap drained, Ramses filled.
  balances[P_CAKE] = 5_000n * 10n ** 6n;
  balances[P_RAM] = 300_000n * 10n ** 6n;
  reads = 0;
  clock += 60_000; await m.tick(false, '2026-10-08');
  assert(reads === 0 && deepestUsdg() === P_CAKE, 'before the refresh interval: no extra reads, old ranking');
  clock += 10 * 60_000; await m.tick(false, '2026-10-08');
  assert(reads === 4, `after 10 min: one bundled depth re-read of all 4 pools (got ${reads})`);
  assert(deepestUsdg() === P_RAM, 'ranking follows the money: Ramses is now the deepest USDG pool');
  assert(m.depthAgeMs() === 0, 'depth age reset after the refresh');

  // Gap maths uses the real fees of the pools it picked:
  // Ramses V2 (0.2%) + Uniswap V3 (0.05%, deeper WETH pool) + 0.05% ETH/USDG leg.
  const row = m.rows()[0];
  if (row && row.rest.samples) {
    const expectedFees = 0.2 + 0.05 + 0.05;
    assert(Math.abs((row.rest.maxGapPct - row.rest.maxNetPct) - expectedFees) < 1e-9, `after-fee gap subtracts the real fees (${expectedFees.toFixed(2)}%), not 0.65%`);
  } else assert(false, 'gap measured');

  // Refresh switched off (0) = old behaviour: never re-reads.
  const frozen = new CrossQuoteMonitor(callMany, USDG, WETH, () => 4_000, () => clock, 0);
  await frozen.setup([
    { dex: 'pancakeswap-v2', kind: 'v2', pool: P_CAKE, token0: TOK, token1: USDG },
    { dex: 'uniswap-v3', kind: 'v3', pool: P_UNI3, token0: TOK, token1: WETH },
  ], 60, 1_000);
  reads = 0; clock += 60 * 60_000; await frozen.tick(false, '2026-10-08');
  assert(reads === 0, 'depthRefreshMs = 0: depth never re-read');
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
