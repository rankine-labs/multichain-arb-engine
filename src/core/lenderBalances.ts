import type { PoolState } from './types';

// ============================================================================
// LENDER BALANCES -- how many coins each possible flash-loan pool really holds.
//
// Plain English:
//   A flash loan borrows coins from a trading pool and pays them back in the
//   same transaction. The bot used to pick the CHEAPEST pool without checking
//   it actually had enough coins to lend, so tiny 0.01%-fee pools got picked
//   and the loan failed ("TF", "TransferFailed", "L" in the checks).
//
//   This keeps a fresh list (refreshed every few minutes, one bundled read)
//   of each candidate pool's real coin balances and whether it has active
//   liquidity. The lender picker then only uses pools holding several times
//   the amount we want to borrow.
// ============================================================================

type Call = { target: string; data: string };
type CallMany = (calls: Call[]) => Promise<(string | null)[]>;

// balanceOf(address) and liquidity() selectors (standard ERC-20 / Uniswap V3).
const BALANCE_OF = '0x70a08231';
const LIQUIDITY = '0x1a686502';

const pad = (addr: string) => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const asBig = (ret: string | null): bigint | null => {
  if (!ret || ret === '0x') return null;
  try { return BigInt(ret.slice(0, 66)); } catch { return null; }
};

export class LenderBalances {
  private bal = new Map<string, bigint>();     // `${pool}:${token}` -> coins the pool holds
  private liq = new Map<string, bigint>();     // pool -> active liquidity right now
  lastRefreshMs = 0;

  // Read balances + liquidity for every candidate V3 pool in one bundled
  // read. Pools that fail to answer are dropped (treated as unknown = unusable).
  async refresh(callMany: CallMany, pools: PoolState[], now = Date.now()): Promise<number> {
    // Only real 20-byte pool and token addresses (Uniswap V4 pools are keyed
    // by a 32-byte id and can't lend this way; native ETH is address 0).
    const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a);
    const v3 = pools.filter((p) => p.poolType === 'v3' && p.dex !== 'uniswap-v4' && isAddr(p.poolAddress) && isAddr(p.tokenA) && isAddr(p.tokenB));
    const calls: Call[] = [];
    for (const p of v3) {
      calls.push({ target: p.tokenA, data: BALANCE_OF + pad(p.poolAddress) });
      calls.push({ target: p.tokenB, data: BALANCE_OF + pad(p.poolAddress) });
      calls.push({ target: p.poolAddress, data: LIQUIDITY });
    }
    if (!calls.length) return 0;
    const res = await callMany(calls);
    const bal = new Map<string, bigint>();
    const liq = new Map<string, bigint>();
    v3.forEach((p, i) => {
      const a = asBig(res[i * 3]);
      const b = asBig(res[i * 3 + 1]);
      const l = asBig(res[i * 3 + 2]);
      const pool = p.poolAddress.toLowerCase();
      if (a !== null) bal.set(`${pool}:${p.tokenA.toLowerCase()}`, a);
      if (b !== null) bal.set(`${pool}:${p.tokenB.toLowerCase()}`, b);
      if (l !== null) liq.set(pool, l);
    });
    this.bal = bal;
    this.liq = liq;
    this.lastRefreshMs = now;
    return v3.length;
  }

  // Coins of `token` the pool holds, or undefined if we don't know.
  balanceOf(pool: string, token: string): bigint | undefined {
    return this.bal.get(`${pool.toLowerCase()}:${token.toLowerCase()}`);
  }

  // Active liquidity at the current price (0 = the pool can't lend: "L" error).
  liquidityOf(pool: string): bigint | undefined {
    return this.liq.get(pool.toLowerCase());
  }

  // Can this pool lend `amount` of `token`, with `headroom` times to spare?
  canLend(pool: string, token: string, amount: bigint, headroom = 3n): boolean {
    const b = this.balanceOf(pool, token);
    const l = this.liquidityOf(pool);
    return b !== undefined && b >= amount * headroom && (l === undefined || l > 0n);
  }
}
