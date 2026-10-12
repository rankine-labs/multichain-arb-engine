# Every-block reader (spec, Oct 11)

## Why
The bot reacts instantly only to trades it can decode from the sequencer feed (known routers, ~half of trades). Other trades are noticed only by the 5 s RPC refresh. Robinhood Chain makes a block every ~0.11 s and has no public mempool. The reader asks the node, every block, for the swap/sync events of the pools the bot watches and writes the exact post-swap pool state into the PoolCache, then triggers the sitting-gap scan.

Measured (probes, Oct 11): free public node answered 99.4% of ~16 req/s, median 28 ms, some HTTP 429s. A third of rival arbitrages followed a trade we can't decode, and rivals were 0.4 s+ late on most of those.

## Module: `src/core/blockReader.ts` (pure parsing + a polling class)

```ts
export type RpcFn = (method: string, params: unknown[]) => Promise<any>;
export interface RpcLog { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionIndex?: string; transactionHash?: string; removed?: boolean }

// Exact pool state carried by one event.
export interface PoolUpdate {
  pool: string;          // lowercase pool address, or lowercase 32-byte V4 pool id (from PoolManager Swap topic1)
  kind: 'v2' | 'v3' | 'v4';
  block: number;
  logIndex: number;
  reserve0?: bigint;     // v2 (from Sync)
  reserve1?: bigint;
  sqrtPriceX96?: bigint; // v3/v4 (from Swap)
  liquidity?: bigint;
  tick?: number;
}

// Topics handled (export the constants):
//  V2/Solidly Sync(uint112 reserve0, uint112 reserve1)            -> kind 'v2' (reserves). V2 Swap events are ignored (no reserves in them).
//  Uniswap V3 / Slipstream / Algebra-compatible Swap(address,address,int256,int256,uint160,uint128,int24) -> 'v3'
//  PancakeSwap V3 Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)             -> 'v3' (same first fields)
//  Algebra Integral may emit Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24) (overrideFee, pluginFee): handle too -> 'v3'
//  Uniswap V4 PoolManager Swap(bytes32 id, address sender, int128, int128, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee) -> 'v4', pool = topic1, ONLY when log.address === poolManager
// Ignore removed logs and unknown topics. Decode signed int24 tick correctly.
export function parsePoolLogs(logs: RpcLog[], poolManager: string): PoolUpdate[];

// Keep only the LAST update per pool (highest block, then logIndex).
export function latestPerPool(updates: PoolUpdate[]): Map<string, PoolUpdate>;

export interface BlockReaderOptions {
  rpc: RpcFn;
  poolManager: string;
  addresses: () => string[];        // pool contract addresses to watch (lowercase); V4 pools are matched via poolManager + topic1
  v4Ids: () => Set<string>;         // V4 pool ids we watch (lowercase)
  onUpdates: (latest: Map<string, PoolUpdate>, toBlock: number) => void;
  pollMs?: number;                  // default 110
  headEveryMs?: number;             // eth_blockNumber refresh, default 2000
  maxRange?: number;                // max blocks per eth_getLogs (default 200); if behind more, jump to head - maxRange and count a skip
  now?: () => number;
}
export class BlockReader {
  constructor(o: BlockReaderOptions);
  start(): void;                    // setTimeout loop, never overlapping polls
  stop(): void;
  // One poll (exported for tests): eth_getLogs { fromBlock: last+1, toBlock: 'latest', address: [...addresses, poolManager], topics: [[all handled topics]] }
  // then filter V4 logs to v4Ids, parse, latestPerPool, call onUpdates if non-empty. Advance `last` to the max blockNumber seen and to the head from eth_blockNumber.
  pollOnce(): Promise<void>;
  // Back off on errors: HTTP 429 / rate-limit -> pause 1 s, other errors -> 500 ms; after 20 errors in a row pause 30 s. Never throw out of the loop.
  stats(): { polls: number; ok: number; errors: number; rateLimited: number; updates: number; skippedRanges: number; lastBlock: number; lagBlocks: number; medianMs: number };
}
```

Requirements: plain-English comments (owner is non-technical), no em dashes in comments, production quality, no new dependencies (ethers v6 is available), unit tests in `src/test/blockReader.test.ts` in the repo's test style (assert() helper printing PASS/FAIL, process.exitCode = 1 on failure), run with `rm -rf .test-build && npm test`.

## Integration (done by the lead, not the module agents)
In `src/shadowMain.ts` (Robinhood only, `BLOCK_READER` env, default on): for each update, find the cached pool (address or V4 id); skip if the trade feed applied a predicted state to that pool in the last 400 ms; write a copy with exact state via `cache.upsertFromFeed`; then `requestGapScan()`. Status line with reader stats.
