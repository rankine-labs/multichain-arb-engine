import { ethers } from 'ethers';
import { DecodedSwap, RawChainEvent, ChainName } from './types';

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
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))',
    'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum))',
    ]),
};

// Router address -> (dex name, ABI style) mapping. Placeholder addresses —
// fill in real router addresses per chain before this goes live. Kept
// separate per chain since the same DEX name can have different router
// addresses on different chains.
export interface RouterRegistryEntry {
  dex: string;
    factory?: string; // v2 factory contract, used for JIT pool resolution (see poolResolver.ts)
  style: 'v2' | 'v3';
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
    private provider?: ethers.JsonRpcProvider, // needed when raw event is only a txHash (Avalanche)
    ) {}

  // Entry point. Returns null if this event isn't a swap we can decode
  // (wrong router, wrong method, unparseable) — that's the normal case for
  // most traffic, not an error.
  async decode(event: RawChainEvent): Promise<DecodedSwap | null> {
    switch (event.chain) {
      case 'avalanche':
      return this.decodeFromTxHash(event);
      case 'monad':
      return this.decodeFromLog(event);
      case 'robinhood':
      return this.decodeFromSequencerCalldata(event);
      default:
      return null;
    }
  }

  // Avalanche's pending feed only gives us a txHash — we have to fetch the
  // full transaction to get calldata. This is the one path with an RPC
  // round-trip in it; everything else decodes from data already in hand.
  private async decodeFromTxHash(event: RawChainEvent): Promise<DecodedSwap | null> {
    if (!this.provider) return null;
    const raw = event.raw as { txHash: string };
    const tx = await this.provider.getTransaction(raw.txHash).catch(() => null);
      if (!tx || !tx.to || !tx.data) return null;

      return this.decodeCalldata('avalanche', tx.to, tx.data, event);
  }

  // Monad's monadLogs feed gives structured log data directly — no extra
  // RPC round trip needed, this is part of why the speculative feed is
  // useful, we get everything we need in the push itself.
  private decodeFromLog(event: RawChainEvent): DecodedSwap | null {
    const raw = event.raw as any;
    // Real Swap events (Uniswap V2/V3 style) carry token amounts directly
    // in the log data rather than needing calldata decoding at all.
    // Placeholder shape — align with actual monadLogs Swap event topic
    // once we're pointed at real pools.
    if (!raw?.address || !raw?.data) return null;

    return {
      chain: 'monad',
      dex: 'unknown', // resolved by looking up raw.address against known pool addresses
      poolAddress: raw.address,
      tokenIn: '0x0',
      tokenOut: '0x0',
      amountIn: 0n,
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

    const iface = ROUTER_INTERFACES[entry.style];
    let parsed: ethers.TransactionDescription | null;
    try {
      parsed = iface.parseTransaction({ data });
    } catch {
      return null; // not a swap method we recognize on this router
    }
    if (!parsed) return null;

    if (entry.style === 'v2') {
      const path = parsed.args.path as string[];
      if (!path || path.length < 2) return null;
      return {
        chain,
        dex: entry.dex,
        poolAddress: to, // resolved to actual pool address by the caller via factory lookup
        tokenIn: path[0],
        tokenOut: path[path.length - 1],
        amountIn: BigInt(parsed.args.amountIn ?? 0),
        stateType: event.stateType,
        detectedAtMs: event.receivedAtMs,
      };
    }

    // v3 exactInputSingle
    const params = parsed.args[0];
    if (!params) return null;
    return {
      chain,
      dex: entry.dex,
      poolAddress: to,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: BigInt(params.amountIn ?? 0),
      stateType: event.stateType,
      detectedAtMs: event.receivedAtMs,
    };
  }
}
