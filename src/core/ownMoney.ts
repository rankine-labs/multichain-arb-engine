// ============================================================================
// OWN MONEY -- how much of our own money a real trade can actually use.
//
// Plain English:
//   "Own money" trades spend coins the trade contract (the executor) already
//   holds; no loan, no loan fee. The bot used to assume it always had up to
//   OWN_MONEY_MAX_USD ($2,000) of every coin. Live, the contract will hold
//   only what the owner deposits (about $1,000 USDG + $300 WETH planned), so a
//   $1,800 trade planned as "own money" would simply fail.
//
//   This keeps the contract's real balances (read every 15 s while live, and
//   right after each real trade) and decides per trade:
//     - own money, if the trade fits under BOTH the $2,000 limit and what the
//       contract really holds of that coin (with a 2% cushion for price moves,
//       and only if the balance was read in the last 60 s)
//     - otherwise a loan from the cheapest approved lender (0.01%)
//   The trade SIZE is never changed here: the pools decide the size (the
//   profit calculator picks the most profitable amount), this only decides
//   how it is paid for.
//
//   Practice runs (not live) have no deposit to read, so they keep the old
//   assumption: own money up to OWN_MONEY_MAX_USD. Practice numbers are
//   therefore unchanged by this file.
// ============================================================================

type CallMany = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;

const SEL_BALANCE_OF = '0x70a08231';
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// Keep 2% of the balance unused, so a price move between planning and
// sending doesn't make an own-money trade ask for more than we hold.
export const OWN_MONEY_CUSHION = 0.98;
// Balances older than this aren't trusted (reads keep failing, or the owner
// withdrew): trades borrow instead until a fresh read comes in.
export const OWN_MONEY_MAX_AGE_MS = 60_000;

export class OwnMoneyBook {
  private readonly balances = new Map<string, bigint>();
  private lastReadMs = 0;

  constructor(private readonly isLive: () => boolean, private readonly now: () => number = Date.now) {}

  // Read the contract's balance of each coin in one bundled request.
  async refresh(callMany: CallMany, holder: string, tokens: string[]): Promise<void> {
    const res = await callMany(tokens.map((t) => ({ target: t, data: SEL_BALANCE_OF + pad(holder) })));
    tokens.forEach((t, i) => {
      const r = res[i];
      // An unreadable balance counts as zero: better a loan than a failed trade.
      this.balances.set(t.toLowerCase(), r && r !== '0x' ? BigInt(r.slice(0, 66)) : 0n);
    });
    this.lastReadMs = this.now();
  }

  // For tests and for recording a balance read elsewhere.
  set(token: string, raw: bigint) { this.balances.set(token.toLowerCase(), raw); this.lastReadMs = this.now(); }

  // Raw units of `token` the contract holds (0 if never read).
  raw(token: string): bigint { return this.balances.get(token.toLowerCase()) ?? 0n; }
  lastReadAgeMs(): number | null { return this.lastReadMs ? this.now() - this.lastReadMs : null; }

  // Dollars of `token` an own-money trade may use right now.
  //   practice: Infinity (only OWN_MONEY_MAX_USD limits it, as before)
  //   live:     the real balance, less the 2% cushion; 0 before the first read
  availableUsd(token: string, usdPerToken: number, decimals: number): number {
    if (!this.isLive()) return Infinity;
    if (!this.lastReadMs || this.now() - this.lastReadMs > OWN_MONEY_MAX_AGE_MS || !(usdPerToken > 0)) return 0;
    return (Number(this.raw(token)) / 10 ** decimals) * usdPerToken * OWN_MONEY_CUSHION;
  }

  // Final check right before a live own-money send: does the contract hold
  // at least the exact amount the trade will spend?
  covers(token: string, amountIn: bigint): boolean {
    if (!this.isLive()) return true;
    const fresh = this.lastReadMs > 0 && this.now() - this.lastReadMs <= OWN_MONEY_MAX_AGE_MS;
    return fresh && this.raw(token) >= amountIn;
  }
}

// Own money or a loan? Pure decision, used for both the practice check and
// the real send so they always agree.
export function useOwnMoney(o: {
  ownMoneyOn: boolean;       // RH_FUNDING is not 'flash'
  tradeSizeUsd: number;      // size the pools picked
  ownMaxUsd: number;         // OWN_MONEY_MAX_USD ($2,000)
  ownAvailableUsd: number;   // OwnMoneyBook.availableUsd(...)
  noBalanceSlot: boolean;    // practice checker can't fake a balance for this coin
}): boolean {
  return o.ownMoneyOn && !o.noBalanceSlot && o.tradeSizeUsd <= Math.min(o.ownMaxUsd, o.ownAvailableUsd);
}
