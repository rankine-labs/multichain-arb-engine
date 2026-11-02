import { AbiCoder, keccak256, ZeroAddress } from 'ethers';
import type { PoolState } from '../core/types';

// Test pools for fix 11 (shared by fix11.test.ts and fix11Speed.test.ts).
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const HOOK = '0x00000000000000000000000000000000000000f9';
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const v4Id = (c0: string, c1: string, fee: number, ts: number, hooks = ZeroAddress) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, ts, hooks])).toLowerCase();

// A mix of V4 pools: matching keys, wrong fee, wrong id, native, hooked,
// bad fields, plus some non-V4 pools.
export function mixedPools(n: number): PoolState[] {
  const out: PoolState[] = [];
  for (let i = 0; i < n; i++) {
    const a = addr(0x1000 + i), b = addr(0x900000 + i);
    const fee = [100, 500, 3000, 10000][i % 4], ts = [1, 10, 60, 200][i % 4];
    const native = i % 7 === 0;
    const c0 = native ? ZeroAddress : a;
    let id = v4Id(c0, b, fee, ts);
    let v4: any = { fee, tickSpacing: ts, native, poolManager: PM };
    const kind = i % 10;
    if (kind === 1) v4 = { ...v4, fee: fee + 1 };                 // key no longer gives the id
    if (kind === 2) id = '0x' + 'ab'.repeat(32);                  // wrong id
    if (kind === 3) { v4 = { ...v4, hooks: HOOK }; }              // hooked: skipped before the key check
    if (kind === 4) v4 = { ...v4, fee: 99_000_000 };              // out of range: encode throws -> false
    if (kind === 5) v4 = { ...v4, hooks: ZeroAddress };           // explicit zero hook
    const p = { chain: 'robinhood', dex: 'uniswap-v4', poolType: 'v3', poolAddress: id, tokenA: a, tokenB: b, feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 1, v4 } as unknown as PoolState;
    out.push(p);
    if (i % 9 === 0) out.push({ chain: 'robinhood', dex: 'uniswap-v2', poolType: 'v2', poolAddress: addr(0x5000000 + i), tokenA: a, tokenB: b, feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 1 } as PoolState);
  }
  return out;
}


// A fake hooked-V4 registry answer (activePools) with n entries: pairs of
// WETH (or native ETH) with coin i, some inactive, checksummed hooks.
const iRegTest = new (require('ethers').Interface)(['function activePools() view returns (tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bytes32 id, bool active)[])']);
export const REG_WETH = '0x00000000000000000000000000000000000000e1';
export function registryAnswer(n: number): string {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const coin = addr(0x700000 + (i % 40));
    const native = i % 3 === 0;
    const c0 = native ? ZeroAddress : (REG_WETH < coin ? REG_WETH : coin), c1 = native ? coin : (REG_WETH < coin ? coin : REG_WETH);
    rows.push([[c0, c1, 3000 + (i % 5), 60, '0xabcdef00000000000000000000000000000000' + (i % 10).toString(16).padStart(2, '0')], '0x' + (i + 1).toString(16).padStart(64, '0'), i % 4 !== 1]);
  }
  return iRegTest.encodeFunctionResult('activePools', [rows]);
}
