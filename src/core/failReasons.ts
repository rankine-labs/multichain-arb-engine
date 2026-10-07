// ============================================================================
// WHY CHECKS FAIL -- turns raw "trade would revert" messages into plain
// English groups for the hourly Telegram report.
//
// Plain English:
//   When a real-chain test says a trade "wouldn't go through", the chain
//   gives back a short, technical reason (e.g. "UniswapV2: K", "STF",
//   "BadRoute()"). This file sorts those into a few groups a person can act on:
//     - tax:      the coin takes a cut when it's moved, so the pool gets less
//                 than our trade expected and cancels it
//     - transfer: coins couldn't be moved: usually the lender pool was too
//                 small (or empty), sometimes a coin that blocks transfers
//     - blocked:  the coin says outright it refuses (blacklist / trading off)
//     - ours:     our bot built the trade wrong (a bug for us to fix)
//     - stale:    our price info for the pool was old or wrong
//     - silent:   failed without giving any reason
//     - other:    anything we don't recognise yet
//   The raw reasons are also kept (counted) so the server log and status page
//   show exactly what the chain said, for diagnosis.
// ============================================================================

export type FailGroup = 'tax' | 'transfer' | 'blocked' | 'ours' | 'stale' | 'silent' | 'other';

// Plain-English label for each group, as shown in Telegram.
export const FAIL_GROUP_LABEL: Record<FailGroup, string> = {
  tax: 'coin takes a cut when moved (skip these coins)',
  transfer: "a coin transfer failed during the test",
  blocked: 'coin blocks trading (likely scam coin)',
  ours: 'our bot built the trade wrong (bug for me to fix)',
  stale: 'price info was old or wrong',
  silent: 'failed with no reason given',
  other: 'other',
};

// Order matters: the first rule that matches wins. Short Uniswap codes
// (LOK, SPL, IIA, STF, TF, AS, K) are matched case-SENSITIVELY as whole
// words so ordinary words like "as" don't trigger them; longer phrases are
// case-insensitive.
const RULES: [FailGroup, RegExp][] = [
  // Our own contract's errors that mean the route/setup we built was wrong.
  // LOK = V3 pool locked (we re-entered it), SPL = we passed a bad price limit.
  ['ours', /BadRoute|UnsupportedKind|ZeroAmount|UnauthorizedCallback|FlashPoolNotAllowed|V4NotEnabled|NotExecutor|Expired|Reentrancy|UnexpectedEth|call unexpectedly succeeded/i],
  ['ours', /\bLOK\b|\bSPL\b/],
  // Uniswap V2 "K" check / insufficient input: the pair received fewer coins
  // than we sent (our contract sends the full amount and asks for the matching
  // output), which is exactly what a transfer tax causes. V3 "IIA" is the same
  // thing on a V3 pool. TokenBalanceDropped = a coin in the middle of the route
  // shrank between hops, also a transfer cut.
  ['tax', /INSUFFICIENT_INPUT_AMOUNT|TokenBalanceDropped/i],
  ['tax', /: K\b|^K$|\bIIA\b/],
  // The coin itself refused to move: transfer helpers failing, blacklists,
  // trading switched off, max-transaction limits.
  // Explicit refusals from the coin itself.
  ['blocked', /blacklist|not allowed|trading (is )?not (enabled|open|active)|tradingEnabled|max ?tx|exceeds (the )?max/i],
  // A transfer failed without saying why (TF / TransferFailed), or the lender
  // pool had no active liquidity (L). Oct 7: seen on WETH/USDG, where fork
  // tests show the coins, lender and routes all work, so the cause is being
  // traced in our own test setup. Could also be a coin that blocks transfers.
  ['transfer', /TRANSFER_FAILED|TransferFailed|transfer amount exceeds/i],
  ['transfer', /\bSTF\b|\bTF\b|^L$/],
  // Pool math didn't match what we expected: price moved or our cached state
  // was off, or the simulated profit was too good to be true.
  ['stale', /INSUFFICIENT_OUTPUT_AMOUNT|INSUFFICIENT_LIQUIDITY|implausible profit|Too little received/i],
  ['stale', /\bAS\b/],
  // The chain reverted with no data at all.
  ['silent', /reverted without data|execution reverted\s*$|^revert$/i],
];

export function classifyFailReason(raw: string): FailGroup {
  const text = (raw ?? '').trim();
  if (!text) return 'silent';
  for (const [group, re] of RULES) if (re.test(text)) return group;
  return 'other';
}

// Shortens a raw reason for counting: long hex (addresses, data) and big
// numbers are collapsed so the same failure on different coins counts once.
export function normaliseRawReason(raw: string): string {
  return (raw ?? '')
    .replace(/0x[0-9a-fA-F]{9,}/g, '0x…') // keeps 4-byte error codes
    .replace(/\d{5,}/g, 'N')
    .trim()
    .slice(0, 80) || '(empty)';
}

// Counts failures for one hour: by plain group and by raw reason.
export class FailTally {
  private groups = new Map<FailGroup, number>();
  private raw = new Map<string, number>();

  add(rawReason: string): FailGroup {
    const g = classifyFailReason(rawReason);
    this.groups.set(g, (this.groups.get(g) ?? 0) + 1);
    const k = normaliseRawReason(rawReason);
    this.raw.set(k, (this.raw.get(k) ?? 0) + 1);
    return g;
  }

  // Plain groups, biggest first: [label, count][].
  plain(): [string, number][] {
    return [...this.groups.entries()].sort((a, b) => b[1] - a[1]).map(([g, c]) => [FAIL_GROUP_LABEL[g], c]);
  }

  // Raw reasons, biggest first, for the log / status page.
  topRaw(n = 5): [string, number][] {
    return [...this.raw.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  total(): number {
    let t = 0;
    for (const c of this.groups.values()) t += c;
    return t;
  }

  clear() { this.groups.clear(); this.raw.clear(); }
}
