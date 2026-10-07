import { LenderBalances } from '../core/lenderBalances';
import { pickV3Lender } from '../execution/executorCalldata';
import type { PoolState } from '../core/types';

// The flash-loan lender must really hold enough of the coin. The old picker
// took the cheapest pool even when it held almost nothing, so loans failed.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const pool = (addr: string, feeBps: number, liquidity: bigint): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v3', poolAddress: addr, poolType: 'v3',
  tokenA: WETH, tokenB: USDG, feeBps, liquidity, sqrtPriceX96: 1n << 96n, lastUpdatedMs: 0,
} as PoolState);

const tiny = pool('0x00000000000000000000000000000000000000a1', 1, 10n ** 12n);   // 0.01% fee, almost empty
const big = pool('0x00000000000000000000000000000000000000a2', 5, 10n ** 18n);    // 0.05% fee, deep
const empty = pool('0x00000000000000000000000000000000000000a3', 1, 10n ** 18n);  // holds coins but 0 active liquidity now

// Fake bundled read: per pool [WETH balance, USDG balance, liquidity].
const answers: Record<string, [bigint, bigint, bigint]> = {
  [tiny.poolAddress]: [10n ** 15n, 10n ** 6n, 10n ** 12n],          // 0.001 WETH
  [big.poolAddress]: [50n * 10n ** 18n, 10n ** 11n, 10n ** 18n],     // 50 WETH
  [empty.poolAddress]: [10n * 10n ** 18n, 10n ** 10n, 0n],           // 10 WETH, liquidity 0
};
const hex = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

async function main() {
  const lb = new LenderBalances();
  const callMany = async (calls: { target: string; data: string }[]) => calls.map((c) => {
    if (c.data === '0x1a686502') return hex(answers[c.target][2]);
    const holder = '0x' + c.data.slice(-40);
    const a = answers[holder];
    return hex(c.target === WETH ? a[0] : a[1]);
  });
  const v4 = { ...big, dex: 'uniswap-v4', poolAddress: '0x' + 'ab'.repeat(32) } as PoolState; // 32-byte V4 id
  const n = await lb.refresh(callMany, [tiny, big, empty, v4]);
  assert(n === 3, 'reads the three real lender pools in one bundle, skips the V4 pool id');
  assert(lb.balanceOf(big.poolAddress, WETH) === 50n * 10n ** 18n, 'stores real WETH balance');

  const loan = 10n ** 17n; // 0.1 WETH
  const canLend = (p: string, t: string) => lb.canLend(p, t, loan, 3n);
  const old = pickV3Lender([tiny, big, empty], WETH, []);
  assert(old?.feeBps === 1, 'old rule (no balance check) picked a cheap 0.01% pool that cannot lend');
  const picked = pickV3Lender([tiny, big, empty], WETH, [], canLend);
  assert(picked?.poolAddress === big.poolAddress, 'new rule skips the near-empty pool and the zero-liquidity pool');
  assert(pickV3Lender([tiny, empty], WETH, [], canLend) === null, 'no pool big enough -> no lender (check uses own capital instead)');
  assert(!lb.canLend('0x00000000000000000000000000000000000000ff', WETH, loan), 'unknown pool is never used');
  assert(lb.canLend(big.poolAddress, WETH, 10n * 10n ** 18n, 3n) && !lb.canLend(big.poolAddress, WETH, 20n * 10n ** 18n, 3n), 'needs 3x headroom: 10 WETH ok from 50, 20 WETH not');
}
main();
