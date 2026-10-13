import { AbiCoder, keccak256, dataSlice } from 'ethers';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildLoopTrade } from '../core/loopTrader';
import type { LoopCycle } from '../core/loopFinder';
import {
  encodeExecuteRaw, decodeExecuteCall, EXECUTE_SELECTOR, KIND_V2, KIND_V3, KIND_SOLIDLY, KIND_V4,
} from '../execution/executorCalldata';
import { PoolState } from '../core/types';

// Encoder parity for LOOPS (3-5 hops): the bot's loop trade builder
// (buildLoopTrade + encodeExecuteRaw) must produce exactly the bytes the
// contract expects for a multi-hop route.
//
// Two checks:
//   1. The calldata decodes back (with a Hop layout written out here field by
//      field from ArbExecutor.sol's struct Hop) to the same 4 hops, in order.
//   2. Its keccak256 equals LOOP4_CALLDATA_HASH, the hash Solidity itself
//      computes for the same trade in contracts/test/LoopRoutes.t.sol
//      (test_encoderParity_loop4_calldataHash). Same trade, same bytes, on
//      both sides; if either layout changes, one of the two tests fails.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Must equal LOOP4_CALLDATA_HASH in contracts/test/LoopRoutes.t.sol.
const LOOP4_CALLDATA_HASH = '0x5eb4a7e5975a4664dc6befc7cfeef95fc0a53676b6334a405448bd1f78dc43f2';

// Real Robinhood coins (src/config/robinhoodSeedPairs.ts); placeholder pools.
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const PONS = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const CASHCAT = '0x020bfC650A365f8BB26819deAAbF3E21291018b4';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const V2_POOL = '0x1111111111111111111111111111111111111111';
const V3_POOL = '0x2222222222222222222222222222222222222222';
const SOLIDLY_POOL = '0x3333333333333333333333333333333333333333';
const V4_POOL_ID = '0x' + '44'.repeat(32); // V4 pools are named by a 32-byte id

function pool(dex: string, poolType: PoolState['poolType'], addr: string, a: string, b: string, feeBps: number, v4?: PoolState['v4']): PoolState {
  return { chain: 'robinhood', dex, poolAddress: addr, poolType, tokenA: a, tokenB: b, feeBps, lastUpdatedBlock: 1, lastUpdatedMs: 0, v4 };
}

// WETH -V2-> PONS -V3-> CASHCAT -Ramses V2 (Solidly)-> USDG -V4 native ETH-> WETH
const pools: PoolState[] = [
  pool('uniswap-v2', 'v2', V2_POOL, WETH, PONS, 30),
  pool('uniswap-v3', 'v3', V3_POOL, PONS, CASHCAT, 30),
  pool('ramses', 'v2', SOLIDLY_POOL, CASHCAT, USDG, 20),
  // Native-ETH V4 pool: tokenA stands for currency0 (WETH for native ETH).
  pool('uniswap-v4', 'v3', V4_POOL_ID, WETH, USDG, 5, {
    fee: 500, tickSpacing: 10, native: true, poolManager: POOL_MANAGER.toLowerCase(), stateView: '0x' + '55'.repeat(20),
  }),
];
const coins = [WETH, PONS, CASHCAT, USDG];
const lc = (s: string) => s.toLowerCase();
const cycle: LoopCycle = {
  id: 0, sig: 'parity', poolSet: 'parity', base: lc(WETH), tokens: coins.map(lc),
  hops: pools.map((p, i) => {
    const tIn = lc(coins[i]), tOut = lc(coins[(i + 1) % coins.length]);
    return { poolKey: lc(p.poolAddress), tokenIn: tIn, tokenOut: tOut, inIsA: lc(p.tokenA) === tIn };
  }),
};

const built = buildLoopTrade({ cycle, pools, amountIn: 10n ** 16n }, () => true);
assert(built.ok, `buildLoopTrade accepts the 4-hop loop (${'reason' in built ? built.reason : 'ok'})`);
if (built.ok) {
  const data = encodeExecuteRaw({ ...built.trade, minProfit: 1n, maxBlock: 123_456n });
  assert(data.startsWith(EXECUTE_SELECTOR), 'calldata starts with the execute() selector');

  // 1. Decode with the struct layout copied from ArbExecutor.sol (Trade{token,
  //    amountIn, minProfit, maxBlock, Hop[]}, Hop{kind, pool, tokenIn,
  //    tokenOut, feeBps, v4Fee, v4TickSpacing, v4Native}) -- independent of
  //    the encoder's own ABI string.
  const SOL_HOP = 'tuple(uint8,address,address,address,uint16,uint24,int24,bool)';
  const [t, flash] = AbiCoder.defaultAbiCoder().decode(
    [`tuple(address,uint256,uint256,uint256,${SOL_HOP}[])`, 'address'], dataSlice(data, 4));
  assert(lc(t[0]) === lc(WETH) && t[1] === 10n ** 16n && t[2] === 1n && t[3] === 123_456n, 'trade header: token WETH, amountIn 0.01, minProfit 1, maxBlock 123456');
  assert(flash === '0x0000000000000000000000000000000000000000', 'own money (flash pool = zero address)');
  const hops = t[4];
  assert(hops.length === 4, 'decodes to 4 hops');
  const expected: [number, string, string, string, number, number, number, boolean][] = [
    [KIND_V2, V2_POOL, WETH, PONS, 30, 0, 0, false],
    [KIND_V3, V3_POOL, PONS, CASHCAT, 0, 0, 0, false],
    [KIND_SOLIDLY, SOLIDLY_POOL, CASHCAT, USDG, 0, 0, 0, false],
    [KIND_V4, POOL_MANAGER, USDG, WETH, 0, 500, 10, true], // V4: pool = PoolManager
  ];
  expected.forEach((e, i) => {
    const h = hops[i];
    const same = Number(h[0]) === e[0] && lc(h[1]) === lc(e[1]) && lc(h[2]) === lc(e[2]) && lc(h[3]) === lc(e[3])
      && Number(h[4]) === e[4] && Number(h[5]) === e[5] && Number(h[6]) === e[6] && h[7] === e[7];
    assert(same, `hop ${i + 1}: kind ${e[0]}, pool, ${lc(e[2]).slice(0, 6)} -> ${lc(e[3]).slice(0, 6)}, feeBps ${e[4]}, v4 fields ${e[5]}/${e[6]}/${e[7]}`);
  });
  // Each hop's output is the next hop's input, and the loop closes on WETH.
  const chained = hops.every((h: string[], i: number) => i === 0 || lc(hops[i - 1][3]) === lc(h[2]));
  assert(chained && lc(hops[0][2]) === lc(WETH) && lc(hops[3][3]) === lc(WETH), 'hops chain and close on the start coin (contract _validateRoute)');

  // Same answer through the encoder's own decoder.
  const [t2] = decodeExecuteCall(data);
  assert(t2.hops.length === 4 && Number(t2.hops[3].v4Fee) === 500 && t2.hops[3].v4Native === true, 'decodeExecuteCall agrees (4 hops, V4 fields on hop 4)');

  // 2. Byte-for-byte match with the bytes Solidity builds for the same trade.
  assert(keccak256(data) === LOOP4_CALLDATA_HASH, `calldata hash matches Solidity's abi.encodeCall (got ${keccak256(data)})`);
}

// The constant above must be the one the Solidity test checks.
const solTest = join(__dirname, '..', '..', 'contracts', 'test', 'LoopRoutes.t.sol');
if (existsSync(solTest)) {
  const m = readFileSync(solTest, 'utf8').match(/LOOP4_CALLDATA_HASH\s*=\s*(0x[0-9a-fA-F]{64})/);
  assert(!!m && lc(m[1]) === LOOP4_CALLDATA_HASH, 'same hash constant as contracts/test/LoopRoutes.t.sol');
}
