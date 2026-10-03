import { ethers } from 'ethers';
import { DecodedSwap, RawChainEvent, ChainName, PoolState } from './types';

// ----------------------------------------------------------------------------
// Swap EVENT signatures (topic0), for chains that give us logs (Monad).
// Computed with `cast keccak "<signature>"`.
// ----------------------------------------------------------------------------
// Uniswap V2 / PancakeSwap V2 / LFJ v1:  Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to)
export const TOPIC_V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
// Uniswap V3:  Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick)
export const TOPIC_V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
// PancakeSwap V3 adds two protocol-fee fields at the end.
export const TOPIC_PANCAKE_V3_SWAP = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';

const abi = ethers.AbiCoder.defaultAbiCoder();

// Looks up a pool we already track (from the pool cache) by its address.
export type PoolLookup = (chain: ChainName, poolAddress: string) => PoolState | undefined;

// ============================================================================
// TRANSACTION DECODER
//
// Blockchains don't send us "someone is buying $800k of ETH." They send
// encoded calldata. This module translates raw event data (whatever shape
// each chain's feed delivers) into a common DecodedSwap the rest of the
// engine can reason about, regardless of which chain or DEX it came from.
// ============================================================================

// Known router method signatures we can decode. Extend this per DEX as we
// add support — Uniswap V2-style and V3-style cover most of Avalanche,
// Monad, and Robinhood Chain's approved DEX list to start.
const ROUTER_INTERFACES: Record<string, ethers.Interface> = {
  v2: new ethers.Interface([
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
    'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] path, address to, uint deadline)',
    'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
    ]),
  v3: new ethers.Interface([
    // Original SwapRouter (has a deadline field)
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))',
    'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum))',
    // SwapRouter02 / PancakeSwap SmartRouter (no deadline field; deadline
    // lives on the multicall wrapper instead). Confirmed by the live probe:
    // Robinhood's busiest router is a SwapRouter02.
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))',
    'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))',
    // SwapRouter02 can also route through V2 pairs (no deadline)
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to)',
    // Most SwapRouter02 calls arrive wrapped in multicall
    'function multicall(bytes[] data)',
    'function multicall(uint256 deadline, bytes[] data)',
    'function multicall(bytes32 previousBlockhash, bytes[] data)',
      ]),
    // Universal Router (Uniswap and PancakeSwap): a list of 1-byte commands,
    // each with its own encoded inputs. We decode the V2 and V3 swap commands.
    ur: new ethers.Interface([
      'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
      'function execute(bytes commands, bytes[] inputs)',
    ]),
    lb: new ethers.Interface([
        // LFJ Liquidity Book router — path is a struct, not a flat address[], since
        // each hop can cross a different bin step / LB version. tokenPath[0] and
        // tokenPath[last] give us tokenIn/tokenOut the same way v2's path does.
        'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline)',
        'function swapExactTokensForNATIVE(uint256 amountIn, uint256 amountOutMinNATIVE, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline)',
        'function swapExactNATIVEForTokens(uint256 amountOutMin, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline)',
        ]),
};
    

// Router address -> (dex name, ABI style) mapping. Placeholder addresses —
// fill in real router addresses per chain before this goes live. Kept
// separate per chain since the same DEX name can have different router
// addresses on different chains.
export interface RouterRegistryEntry {
  dex: string;
    factory?: string; // v2 factory contract, used for JIT pool resolution (see poolResolver.ts)
    style: 'v2' | 'v3' | 'lb' | 'ur';
    // Routers that can trade through BOTH V2 and V3 pools (SwapRouter02,
    // Universal Router) point at the registry entry to use for each pool
    // type: the decoded swap is attributed to that router, so pool lookup
    // uses the right factory.
    v2Via?: string;
    v3Via?: string;
}

// Universal Router command IDs (low 6 bits of each command byte).
const UR_V3_SWAP_EXACT_IN = 0x00;
const UR_V2_SWAP_EXACT_IN = 0x08;
// Universal Router "use the router's whole balance" placeholder amount;
// the real amount isn't known from calldata, so those swaps are skipped.
const UR_CONTRACT_BALANCE = 1n << 255n;

// First pool hop of a V3 packed path: tokenIn (20 bytes) + fee (3) + next token (20).
function firstV3Hop(path: string): { tokenIn: string; tokenOut: string; fee: number } | null {
  const hex = path.startsWith('0x') ? path.slice(2) : path;
  if (hex.length < (20 + 3 + 20) * 2) return null;
  return {
    tokenIn: ethers.getAddress('0x' + hex.slice(0, 40)),
    fee: parseInt(hex.slice(40, 46), 16),
    tokenOut: ethers.getAddress('0x' + hex.slice(46, 86)),
  };
}

export type RouterRegistry = Record<ChainName, Record<string /* router address, lowercase */, RouterRegistryEntry>>;

export const DEFAULT_ROUTER_REGISTRY: RouterRegistry = {
  avalanche: {
    // '0xROUTER_ADDRESS': { dex: 'traderjoe', style: 'v2' },
  },
    monad: {
      // '0xROUTER_ADDRESS': { dex: 'uniswap', style: 'v3' },
    },
      robinhood: {
        // '0xROUTER_ADDRESS': { dex: 'arcus', style: 'v2' },
      },
};

export class TransactionDecoder {
  constructor(
    private registry: RouterRegistry = DEFAULT_ROUTER_REGISTRY,
    // Only used if an Avalanche event carries just a txHash (the adapter
    // normally passes to/data already, so no extra round trip is needed).
    private provider?: ethers.JsonRpcProvider,
    // Needed to decode Monad Swap logs: a log only says "pool X swapped
    // amount0/amount1", so we need the pool's two tokens to know which
    // token went in. Only pools we already track can be decoded -- which is
    // fine, since an untracked pool has no peer to arb against anyway.
    private poolLookup?: PoolLookup,
    ) {}

  // Entry point. Returns null if this event isn't a swap we can decode
  // (wrong router, wrong method, unparseable) — that's the normal case for
  // most traffic, not an error.
  async decode(event: RawChainEvent): Promise<DecodedSwap | null> {
    switch (event.chain) {
      case 'avalanche':
      return this.decodeFromTx(event);
      case 'monad':
      return this.decodeFromLog(event);
      case 'robinhood':
      return this.decodeFromSequencerCalldata(event);
      default:
      return null;
    }
  }

  // Avalanche: the adapter already fetched the pending tx and passes
  // { to, data }. (This used to ignore them and re-fetch by hash with a
  // provider that was never supplied, so every Avalanche swap decoded to
  // nothing.) Falls back to fetching only if just a hash was given.
  private async decodeFromTx(event: RawChainEvent): Promise<DecodedSwap | null> {
    const raw = event.raw as { to?: string; data?: string; txHash?: string; hash?: string };
    if (raw?.to && raw?.data) return this.decodeCalldata('avalanche', raw.to, raw.data, event);
    const hash = raw?.txHash ?? raw?.hash;
    if (!this.provider || !hash) return null;
    const tx = await this.provider.getTransaction(hash).catch(() => null);
    if (!tx || !tx.to || !tx.data) return null;
    return this.decodeCalldata('avalanche', tx.to, tx.data, event);
  }

  // Monad's monadLogs feed pushes each log ~1s before finalization, with
  // the data we need already in it -- no extra RPC round trip.
  //
  // We decode Swap events from pools we track:
  //   V2-style (Uniswap V2 / PancakeSwap V2 / LFJ v1): amountXIn / amountXOut
  //   V3-style (Uniswap V3, PancakeSwap V3): signed amount0 / amount1,
  //     positive = paid INTO the pool (that's the token going in)
  // token0 is always the lower address on these DEXes, which tells us which
  // amount belongs to which token. (This used to be a placeholder that
  // returned an empty swap, so no Monad trade was ever evaluated.)
  private decodeFromLog(event: RawChainEvent): DecodedSwap | null {
    const raw = event.raw as any;
    const log = raw?.log ?? raw; // tolerate either a bare log or { log: ... }
    const topics: string[] | undefined = log?.topics;
    const address: string | undefined = log?.address;
    const data: string | undefined = log?.data;
    if (!address || !data || !topics?.length) return null;

    const topic0 = topics[0].toLowerCase();
    if (topic0 !== TOPIC_V2_SWAP && topic0 !== TOPIC_V3_SWAP && topic0 !== TOPIC_PANCAKE_V3_SWAP) return null;

    const pool = this.poolLookup?.('monad', address);
    if (!pool) return null; // not a pool we track

    const [token0, token1] = pool.tokenA.toLowerCase() < pool.tokenB.toLowerCase()
      ? [pool.tokenA, pool.tokenB]
      : [pool.tokenB, pool.tokenA];

    let tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint;
    try {
      if (topic0 === TOPIC_V2_SWAP) {
        const [a0In, a1In, a0Out, a1Out] = abi.decode(['uint256', 'uint256', 'uint256', 'uint256'], data) as unknown as bigint[];
        if (a0In > 0n) { tokenIn = token0; tokenOut = token1; amountIn = a0In; amountOut = a1Out; }
        else { tokenIn = token1; tokenOut = token0; amountIn = a1In; amountOut = a0Out; }
      } else {
        // V3 and Pancake V3 share the same first two data fields.
        const [amount0, amount1] = abi.decode(['int256', 'int256'], data.slice(0, 2 + 64 * 2)) as unknown as bigint[];
        if (amount0 > 0n) { tokenIn = token0; tokenOut = token1; amountIn = amount0; amountOut = -amount1; }
        else { tokenIn = token1; tokenOut = token0; amountIn = amount1; amountOut = -amount0; }
      }
    } catch {
      return null; // malformed log
    }
    if (amountIn <= 0n) return null;

    return {
      chain: 'monad',
      dex: pool.dex,
      poolAddress: pool.poolAddress,
      tokenIn,
      tokenOut,
      amountIn,
      amountOutObserved: amountOut > 0n ? amountOut : undefined,
      stateType: event.stateType,
      detectedAtMs: event.receivedAtMs,
    };
  }

  // Robinhood's sequencer feed gives us calldata directly, before
  // execution. No result is ever included, so tokenOut/amountOut have to
  // be predicted from local pool state, never read off this event.
  private decodeFromSequencerCalldata(event: RawChainEvent): DecodedSwap | null {
    const raw = event.raw as any;
    const to = raw?.to as string | undefined;
    const data = raw?.data ?? raw?.input;
    if (!to || !data) return null;

    return this.decodeCalldata('robinhood', to, data, event);
  }

  private decodeCalldata(chain: ChainName, to: string, data: string, event: RawChainEvent): DecodedSwap | null {
    const entry = this.registry[chain][to.toLowerCase()];
    if (!entry) return null; // not a router we're tracking — most traffic falls here
    // Native-coin swaps (swapExactETHForTokens etc.) carry the amount as the
    // tx value, not an argument.
    const value = (() => { try { return BigInt((event.raw as any)?.value ?? 0); } catch { return 0n; } })();
    return this.decodeRouterCall(chain, to, entry, data, event, value, 0);
  }

  // Builds the swap; `via` = the registry router whose factory should be used.
  private swapOf(
    chain: ChainName, via: string | undefined, tokenIn: string, tokenOut: string,
    amountIn: bigint, event: RawChainEvent, feeTier?: number,
  ): DecodedSwap | null {
    if (!via || amountIn <= 0n || amountIn >= UR_CONTRACT_BALANCE) return null;
    const viaEntry = this.registry[chain][via.toLowerCase()];
    if (!viaEntry) return null;
    return {
      chain,
      dex: viaEntry.dex,
      poolAddress: via, // resolved to the actual pool by the caller via that router's factory
      tokenIn,
      tokenOut,
      amountIn,
      feeTier,
      stateType: event.stateType,
      detectedAtMs: event.receivedAtMs,
    };
  }

  private decodeRouterCall(
    chain: ChainName, to: string, entry: RouterRegistryEntry, data: string,
    event: RawChainEvent, value: bigint, depth: number,
  ): DecodedSwap | null {
    if (depth > 2) return null;
    const iface = ROUTER_INTERFACES[entry.style];
    let parsed: ethers.TransactionDescription | null;
    try {
      parsed = iface.parseTransaction({ data });
    } catch {
      return null; // not a swap method we recognize on this router
    }
    if (!parsed) return null;
    const a = parsed.args;

    // --- multicall: decode the first inner call that is a swap -------------
    if (parsed.name === 'multicall') {
      const calls = a[a.length - 1] as string[];
      for (const inner of calls ?? []) {
        const swap = this.decodeRouterCall(chain, to, entry, inner, event, value, depth + 1);
        if (swap) return swap;
      }
      return null;
    }

    // --- Universal Router ---------------------------------------------------
    if (entry.style === 'ur') {
      const commands = ethers.getBytes(a[0] as string);
      const inputs = a[1] as string[];
      const coder = ethers.AbiCoder.defaultAbiCoder();
      for (let i = 0; i < commands.length && i < inputs.length; i++) {
        const cmd = commands[i] & 0x3f;
        try {
          if (cmd === UR_V3_SWAP_EXACT_IN) {
            const [, amountIn, , path] = coder.decode(['address', 'uint256', 'uint256', 'bytes', 'bool'], inputs[i]);
            const hop = firstV3Hop(path as string);
            const swap = hop && this.swapOf(chain, entry.v3Via, hop.tokenIn, hop.tokenOut, amountIn as bigint, event, hop.fee);
            if (swap) return swap;
          } else if (cmd === UR_V2_SWAP_EXACT_IN) {
            const [, amountIn, , path] = coder.decode(['address', 'uint256', 'uint256', 'address[]', 'bool'], inputs[i]);
            const p = path as string[];
            const swap = p.length >= 2 ? this.swapOf(chain, entry.v2Via, p[0], p[1], amountIn as bigint, event) : null;
            if (swap) return swap;
          }
        } catch { /* malformed input for this command; try the next */ }
      }
      return null;
    }

    // --- V2-style router ------------------------------------------------------
    // First hop only: amountIn goes into the path[0]/path[1] pair. (Using
    // the LAST token, as before, pointed multi-hop trades at the wrong pool.)
    if (entry.style === 'v2') {
      const path = a.path as string[];
      if (!path || path.length < 2) return null;
      const amountIn = a.amountIn !== undefined ? BigInt(a.amountIn) : value;
      return this.swapOf(chain, to, path[0], path[1], amountIn, event);
    }

    // --- Liquidity Book router ---------------------------------------------
    if (entry.style === 'lb') {
      const tokenPath = (a.path as { tokenPath: string[] })?.tokenPath;
      if (!tokenPath || tokenPath.length < 2) return null;
      const amountIn = a.amountIn !== undefined ? BigInt(a.amountIn) : value;
      return this.swapOf(chain, to, tokenPath[0], tokenPath[1], amountIn, event);
    }

    // --- V3-style router (SwapRouter / SwapRouter02 / SmartRouter) ---------
    if (parsed.name === 'swapExactTokensForTokens') {
      // V2 trade routed through a SwapRouter02-type router
      const path = a.path as string[];
      if (!path || path.length < 2) return null;
      return this.swapOf(chain, entry.v2Via, path[0], path[1], BigInt(a.amountIn), event);
    }
    const params = a[0];
    if (!params) return null;
    if (parsed.name === 'exactInputSingle') {
      return this.swapOf(chain, to, params.tokenIn, params.tokenOut, BigInt(params.amountIn ?? 0), event, Number(params.fee));
    }
    if (parsed.name === 'exactInput') {
      // Multi-hop: decode the packed path. (Previously returned no tokens.)
      const hop = firstV3Hop(params.path);
      return hop ? this.swapOf(chain, to, hop.tokenIn, hop.tokenOut, BigInt(params.amountIn ?? 0), event, hop.fee) : null;
    }
    return null;
  }
}
