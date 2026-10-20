// ============================================================================
// TEST HELPER: a tiny fake Robinhood node with recorded-style answers.
//
// It answers the handful of methods the harness uses, in the same shapes the
// real node (Nitro / QuickNode) sends, so the whole pipeline can be tested
// without a network:
//   eth_blockNumber, eth_getLogs, eth_getBlockByNumber,
//   eth_call (token balance-slot probe; standing-gap checks),
//   eth_simulateV1 (follow-a-trade replays),
//   debug_traceBlockByNumber (prestate diff), debug_traceCall (fixture mode)
// The "profit" a check makes is a fixed function of its calldata, so node
// and fake engines can agree or disagree on purpose.
// ============================================================================
import { ethers } from 'ethers';
import { Rpc, SIM_EXECUTOR_ADDRESS } from '../../../src/execution/simulator';
import { V3_SWAP_TOPIC, SYNC_TOPIC } from '../../../src/core/blockReader';
import { PoolState } from '../../../src/core/types';
import { USDG, WETH, buildPoolBook } from '../pools';

export const IFACE = new ethers.Interface(['error InsufficientProfit(uint256 got, uint256 wanted)', 'error TransferFailed()', 'error Error(string)']);
export const MAX = (1n << 256n) - 1n;
export const profitRevert = (got: bigint) => IFACE.encodeErrorResult('InsufficientProfit', [got, MAX]).toLowerCase();

export const P_V3 = '0x1111111111111111111111111111111111111111';
export const P_V2 = '0x2222222222222222222222222222222222222222';
export const P_CAKE = '0x3333333333333333333333333333333333333333';
export const OTHER = '0x9999999999999999999999999999999999999999'; // not watched
const BALANCE_SLOT = 9; // USDG keeps balances at mapping slot 9 (fake)

export function testPools(): PoolState[] {
  const base = { chain: 'robinhood' as const, tokenA: WETH, tokenB: USDG, lastUpdatedBlock: 0, lastUpdatedMs: 0 };
  return [
    { ...base, dex: 'uniswap-v3', poolAddress: P_V3, poolType: 'v3', feeBps: 5, sqrtPriceX96: 1n << 96n, liquidity: 10n ** 18n },
    { ...base, dex: 'uniswap-v2', poolAddress: P_V2, poolType: 'v2', feeBps: 30, reserveA: 10n ** 20n, reserveB: 10n ** 11n },
    { ...base, dex: 'pancakeswap-v3', poolAddress: P_CAKE, poolType: 'v3', feeBps: 1, sqrtPriceX96: 1n << 96n, liquidity: 10n ** 18n },
  ];
}
export const testBook = () => buildPoolBook(testPools(), { [WETH]: { symbol: 'WETH', decimals: 18 }, [USDG]: { symbol: 'USDG', decimals: 6 } });

const hex = (n: number | bigint) => '0x' + BigInt(n).toString(16);
const word = (n: bigint) => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0');

// Blocks with trades: block number -> list of (tx index, pool, kind)
export interface FakeOpts {
  head?: number;
  trades?: Array<{ block: number; index: number; pool: string; sync?: boolean }>;
  stateGoneBefore?: number;          // blocks before this: "missing trie node"
  busyTimes?: number;                // first N simulate/eth_call checks answer 429
  profitOf?: (data: string) => bigint;
  gasOf?: (data: string) => bigint;
}

export const defaultProfit = (data: string) => BigInt(ethers.keccak256(data)) % 1000n; // 0 = loss
export const defaultGas = (data: string) => 300_000n + (BigInt(ethers.keccak256(data)) % 50_000n);

export function makeFakeNode(o: FakeOpts = {}): { rpc: Rpc; calls: Record<string, number>; last: Record<string, unknown[]> } {
  const head = o.head ?? 2_000;
  const trades = o.trades ?? [];
  const calls: Record<string, number> = {};
  const last: Record<string, unknown[]> = {};
  let busy = o.busyTimes ?? 0;
  const profitOf = o.profitOf ?? defaultProfit;
  const gasOf = o.gasOf ?? defaultGas;
  const slotKey = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [SIM_EXECUTOR_ADDRESS, BALANCE_SLOT])).toLowerCase();
  const txHash = (b: number, i: number) => ethers.keccak256(ethers.toUtf8Bytes(`tx-${b}-${i}`)).toLowerCase();
  const blockOf = (n: number) => {
    const txs: any[] = [];
    const maxIdx = Math.max(3, ...trades.filter((t) => t.block === n).map((t) => t.index + 1));
    for (let i = 0; i <= maxIdx; i++) {
      txs.push({
        hash: txHash(n, i), from: '0x' + 'ab'.repeat(20), to: i === 1 ? null : '0x' + 'cd'.repeat(20), input: '0x1234' + i.toString(16).padStart(4, '0'),
        value: '0x0', gas: '0x30d40', type: i === 0 ? '0x6a' : '0x2', blockNumber: hex(n), transactionIndex: hex(i),
      });
    }
    return {
      number: hex(n), timestamp: hex(1_760_000_000 + n), l1BlockNumber: hex(23_000_000 + Math.floor(n / 50)), baseFeePerGas: '0x989680',
      miner: '0xa4b000000000000000000073657175656e636572', gasLimit: '0x4000000000000', mixHash: '0x' + '11'.repeat(32), difficulty: '0x1', transactions: txs,
    };
  };
  const answerFor = (data: string) => ({ revert: profitRevert(profitOf(data)), gas: gasOf(data) });
  const rpc: Rpc = async (method, params) => {
    calls[method] = (calls[method] ?? 0) + 1;
    last[method] = params;
    const p = params as any[];
    switch (method) {
      case 'eth_blockNumber': return { result: hex(head) };
      case 'eth_getLogs': {
        const f = p[0];
        const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
        const want = new Set((f.address as string[]).map((a) => a.toLowerCase()));
        const logs = trades.filter((t) => t.block >= from && t.block <= to && want.has(t.pool)).map((t) => t.sync
          ? { address: t.pool, topics: [SYNC_TOPIC], data: '0x' + word(10n ** 20n) + word(10n ** 11n), blockNumber: hex(t.block), logIndex: hex(t.index * 2), transactionIndex: hex(t.index), transactionHash: txHash(t.block, t.index) }
          : { address: t.pool, topics: [V3_SWAP_TOPIC, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: '0x' + word(5n) + word(-4n) + word(1n << 96n) + word(10n ** 18n) + word(-3n), blockNumber: hex(t.block), logIndex: hex(t.index * 2), transactionIndex: hex(t.index), transactionHash: txHash(t.block, t.index) });
        // A real log list also carries events of pools we don't watch? No: the
        // node filters by address. Add one Swap from an unwatched pool anyway
        // to prove the harness ignores it if a node returns extras.
        logs.push({ address: OTHER, topics: [V3_SWAP_TOPIC, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: '0x' + word(1n) + word(-1n) + word(1n << 96n) + word(1n) + word(0n), blockNumber: hex(from), logIndex: '0x0', transactionIndex: '0x2', transactionHash: txHash(from, 2) });
        return { result: logs };
      }
      case 'eth_getBlockByNumber': {
        const n = Number(BigInt(p[0]));
        if (o.stateGoneBefore && n < o.stateGoneBefore - 100_000) return { result: null };
        return { result: blockOf(n) };
      }
      case 'eth_call': {
        const [call, tag, ov] = p;
        // Token balance-slot probe: answer with whatever the override puts at our slot.
        if (call.to.toLowerCase() !== SIM_EXECUTOR_ADDRESS) {
          const diff = ov?.[call.to]?.stateDiff ?? {};
          const v = Object.entries(diff).find(([k]) => k.toLowerCase() === slotKey)?.[1] as string | undefined;
          return { result: '0x' + word(v ? BigInt(v) : 0n) };
        }
        if (busy > 0) { busy--; return { error: { code: 429, message: 'rate limited (HTTP 429)' } }; }
        const n = Number(BigInt(tag));
        if (o.stateGoneBefore && n < o.stateGoneBefore) return { error: { code: -32000, message: 'missing trie node abc (path )' } };
        return { error: { code: 3, message: 'execution reverted', data: answerFor(call.data).revert } };
      }
      case 'eth_simulateV1': {
        if (busy > 0) { busy--; return { error: { code: 429, message: 'rate limited (HTTP 429)' } }; }
        const [{ blockStateCalls }, tag] = p;
        const n = Number(BigInt(tag));
        if (o.stateGoneBefore && n < o.stateGoneBefore) return { error: { code: -32000, message: 'missing trie node 5a1b (path )' } };
        const cs: any[] = blockStateCalls[0].calls;
        const ours = cs[cs.length - 1];
        const a = answerFor(ours.data);
        return { result: [{ number: hex(n + 1), calls: [
          ...cs.slice(0, -1).map((_, i) => ({ status: i === 1 ? '0x0' : '0x1', returnData: '0x', gasUsed: '0x5208', logs: [] })),
          { status: '0x0', returnData: '0x', gasUsed: hex(a.gas), error: { code: 3, message: 'execution reverted', data: a.revert } },
        ] }] };
      }
      case 'debug_traceBlockByNumber': {
        const n = Number(BigInt(p[0]));
        const b = blockOf(n);
        return { result: b.transactions.map((t, i) => ({ txHash: t.hash, result: { pre: { [P_V3]: { balance: '0x0', storage: { ['0x' + '0'.repeat(63) + '1']: '0x' + word(BigInt(i)) } } }, post: { [P_V3]: { storage: { ['0x' + '0'.repeat(63) + '1']: '0x' + word(BigInt(i + 1)) } } } } })) };
      }
      case 'debug_traceCall': {
        const [call, , cfg] = p;
        const a = answerFor(call.data);
        if (cfg.tracer === 'prestateTracer') return { result: { [P_V3]: { balance: '0x0', nonce: 1, code: '0x60', storage: { ['0x' + '0'.repeat(63) + '1']: '0x' + word(7n) } }, '0x0000000000000000000000000000000000000064': { balance: '0x0' } } };
        return { result: { type: 'CALL', from: call.from, to: call.to, gasUsed: hex(a.gas), output: a.revert, error: 'execution reverted' } };
      }
      default: return { error: { code: -32601, message: `method ${method} does not exist` } };
    }
  };
  return { rpc, calls, last };
}

// Simple asserts in the repo's test style (PASS/FAIL lines, non-zero exit on failure).
export function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
