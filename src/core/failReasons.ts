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
//     - transfer: a coin transfer failed during the test (cause being
//                 traced; can also be a coin that blocks transfers)
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

// ============================================================================
// SIMULATION OUTCOME BUCKETS
//
// Plain English:
//   Every real-chain check ends in exactly one of these buckets, so a report
//   can tell "the trade would lose money" apart from "the check itself
//   couldn't run". The first four say something about the TRADE; the rest
//   are about our tools or the node:
//     profit               the trade would make money (exact amount known)
//     real_loss            the trade would end with less than it started
//                          (our profit check said 0, or a flash loan could
//                          not be repaid from the trade's proceeds)
//     token_transfer       a token refused to move (transfer failed, not
//                          enough balance, transfer tax, blocked coin)
//     contract_revert      any other revert: a pool or our contract said no
//                          (bad route, stale price, pool locked, ...)
//     missing_revert_data  it reverted but the node gave no reason to read
//     override_unsupported the node can't do "pretend state" (state overrides)
//     rpc_failure          rate limit, quota, timeout or network trouble
//     replay_unavailable   the exact-moment replay (eth_simulateV1) couldn't
//                          run on this node / block; a plain check is used
//     not_simulable        this token or route can't be simulated here
//                          (e.g. its balance storage wasn't found)
// The raw-reason groups above (tax/transfer/...) are reused, not duplicated.
// ============================================================================

export type SimBucket =
  | 'profit'
  | 'real_loss'
  | 'token_transfer'
  | 'contract_revert'
  | 'missing_revert_data'
  | 'override_unsupported'
  | 'rpc_failure'
  | 'replay_unavailable'
  | 'not_simulable';

export const SIM_BUCKET_LABEL: Record<SimBucket, string> = {
  profit: 'would make money',
  real_loss: 'would lose money',
  token_transfer: 'a token refused to move',
  contract_revert: 'a pool or our contract refused the trade',
  missing_revert_data: 'refused without giving a reason',
  override_unsupported: "node can't do pretend-state checks",
  rpc_failure: 'node busy, out of allowance or unreachable',
  replay_unavailable: 'exact-moment replay not possible on this node/block',
  not_simulable: "this token/route can't be checked here",
};

// True when the bucket says something about the TRADE (not about our tools).
export function isTradeVerdict(b: SimBucket): boolean {
  return b === 'profit' || b === 'real_loss' || b === 'token_transfer' || b === 'contract_revert';
}

// Bucket for a check result from its status and reason text. The simulator
// tags its results with this; it also works as a fallback for any result
// that wasn't tagged.
export function classifySimOutcome(status: string, reason = ''): SimBucket {
  if (status === 'profit') return 'profit';
  if (status === 'loss') return 'real_loss';
  if (status === 'rate_limited') return 'rpc_failure';
  const r = (reason ?? '').trim();
  if (/^replay (unavailable|returned no result)/i.test(r)) return 'replay_unavailable';
  if (status === 'unsupported') {
    return /override|does not support|too many arguments|invalid params/i.test(r) ? 'override_unsupported' : 'not_simulable';
  }
  // status 'fail' (or anything else): look at what the chain said.
  if (!r || /reverted without data|^execution reverted\s*:?\s*$|^revert$|^revert 0x$/i.test(r)) return 'missing_revert_data';
  const g = classifyFailReason(r);
  if (g === 'transfer' || g === 'tax' || g === 'blocked' || /exceeds balance|insufficient balance/i.test(r)) return 'token_transfer';
  if (g === 'silent') return 'missing_revert_data';
  return 'contract_revert';
}

// Counts check outcomes by bucket (e.g. per hour, for a report line).
export class SimBucketTally {
  private counts = new Map<SimBucket, number>();
  add(b: SimBucket): void { this.counts.set(b, (this.counts.get(b) ?? 0) + 1); }
  get(b: SimBucket): number { return this.counts.get(b) ?? 0; }
  // [label, count], biggest first.
  plain(): [string, number][] {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => [SIM_BUCKET_LABEL[k], c]);
  }
  clear(): void { this.counts.clear(); }
}
