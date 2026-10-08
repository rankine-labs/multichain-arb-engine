import type { PoolState } from './types';

// ============================================================================
// V3 BALANCE BOOK -- how much money a V3 pool REALLY holds.
//
// Plain English:
//   For a Uniswap V3 style pool we normally estimate depth from its
//   "virtual reserves" (liquidity / price). That number assumes the liquidity
//   at today's price stretches forever. When a pool's liquidity is squeezed
//   into a narrow price band, the virtual number can be many times bigger
//   than the coins actually sitting in the pool: a pool holding $800 can look
//   like a $40,000 pool. That let thin pools set prices (the ORBIO problem).
//
//   The fix: read each V3 pool's real token balances (balanceOf) every
//   ~10 minutes in one bundled request, off the trading path, and cap the
//   depth estimate at what's really there:
//       executable depth = min(virtual depth near the price, real balance)
//   The real balance is the most a trade could ever take out; the virtual
//   depth tells how fast the price moves while doing so. Neither alone is
//   honest; the smaller of the two is.
//
//   V4 pools are skipped: their coins all sit together in one PoolManager,
//   so there is no per-pool balance to read. Their depth stays "virtual"
//   and the oracle labels it as such.
// ============================================================================

type CallMany = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;

const SEL_BALANCE = '0x70a08231'; // balanceOf(address)
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

export class V3BalanceBook {
  private bal = new Map<string, bigint>(); // "pool:token" -> raw balance
  private readAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  // Raw balance of `token` held by `pool`, or undefined if not read yet.
  get(pool: string, token: string): bigint | undefined {
    return this.bal.get(`${pool.toLowerCase()}:${token.toLowerCase()}`);
  }

  size(): number { return this.bal.size; }
  ageMs(): number { return this.readAt ? this.now() - this.readAt : Infinity; }

  // Read both token balances of every V3 pool (not V4) in one bundled call.
  // Returns how many balances were read. Failures keep the old values.
  async refresh(callMany: CallMany, pools: PoolState[], maxPools = 1_500): Promise<number> {
    const v3 = pools.filter((p) => p.poolType === 'v3' && !p.v4 && /^0x[0-9a-fA-F]{40}$/.test(p.poolAddress)).slice(0, maxPools);
    if (!v3.length) return 0;
    const calls = v3.flatMap((p) => [
      { target: p.tokenA, data: SEL_BALANCE + pad(p.poolAddress) },
      { target: p.tokenB, data: SEL_BALANCE + pad(p.poolAddress) },
    ]);
    const res = await callMany(calls);
    if (this.bal.size > 10_000) this.bal.clear(); // bounded memory (refilled just below)
    let n = 0;
    v3.forEach((p, i) => {
      for (const [k, tok] of [[0, p.tokenA], [1, p.tokenB]] as const) {
        const r = res[i * 2 + k];
        if (!r || r === '0x') continue;
        try { this.bal.set(`${p.poolAddress.toLowerCase()}:${tok.toLowerCase()}`, BigInt(r.slice(0, 66))); n++; } catch { /* bad answer: skip */ }
      }
    });
    this.readAt = this.now();
    return n;
  }
}
