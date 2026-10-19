// ============================================================================
// CHECK FIRST, THEN SEND (live "follow a trade" sends, Oct 19, owner approved)
//
// Plain English:
//   Until now a live "follow a trade" send went out about 20-50 ms after the
//   bot saw someone else's trade, on the bot's own price guess. The real check
//   (a free test run of our exact trade on the actual chain) only ran AFTER the
//   send. Over the whole log the real check said WIN 0 times, LOSS 296 times and
//   "would fail" 63 times, and every live trade failed (gas wasted each time).
//
//   New order for live "follow a trade" sends:
//     1. wait until the trade we follow is in a block (it's in the chain's state)
//     2. run the real check of our exact trade on that state
//     3. send ONLY if the check says it makes money after gas and clears the
//        normal send minimum; the send uses the smaller of guess and check
//   Slower, so some races are lost. A lost race costs nothing; a failed trade
//   costs gas. Sitting-gap trades already work this way and are unchanged.
//   TRIGGER_CHECK_FIRST=0 turns it off (old behaviour: send first).
// ============================================================================

type Rpc = (method: string, params: unknown[]) => Promise<{ result?: any; error?: any }>;

export function checkFirstOn(): boolean {
  return process.env.TRIGGER_CHECK_FIRST !== '0';
}

// Waits until the trade we follow has a receipt (it is in a block). Returns
// true when it landed, false if it did not show up in time or the node errors.
// pollMs x maxPolls = how long we are willing to wait (default 150 ms x 12).
export async function waitForTrade(
  rpc: Rpc, hash: string, pollMs = 150, maxPolls = 12,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return false;
  for (let i = 0; i < maxPolls; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r.error) return false;
    if (r.result?.blockNumber) return true;
    await sleep(pollMs);
  }
  return false;
}

// What the real check said, in the same shape checkRoundTrip returns.
export type CheckAnswer =
  | { status: 'profit'; usd: number }
  | { status: 'loss' | 'fail' | 'skipped'; reason: string }
  | { status: 'rate_limited' };

// One flat shape (works without strict type narrowing):
//   send: go or not; netUsd: profit to send on (0 when not sent)
//   why: reason when not sent; blockPair: a real loss/fail (block the pair 6 h)
export type CheckFirstVerdict = { send: boolean; netUsd: number; why: string; blockPair: boolean };
const no = (why: string, blockPair: boolean): CheckFirstVerdict => ({ send: false, netUsd: 0, why, blockPair });

// Decides send / don't send from the real check.
//   checkProfitUsd: profit before gas the check found (USD)
//   gasUsd: our gas for this trade; minUsd: the normal send minimum
//   modelNetUsd: the bot's own guess after costs (never trust it above the check)
export function decideCheckFirst(c: CheckAnswer, gasUsd: number, minUsd: number, modelNetUsd: number): CheckFirstVerdict {
  if (c.status === 'rate_limited') return no('real check not possible right now (node busy)', false);
  if (c.status === 'skipped') return no(`real check skipped (${c.reason})`, false);
  if (c.status === 'loss') return no('real check: would lose money', true);
  if (c.status === 'fail') return no('real check: would fail', true);
  if (c.status !== 'profit') return no('real check: unknown answer', false);
  const usd = (c as { usd: number }).usd; // profit before gas
  if (!Number.isFinite(usd)) return no('real check: bad number', false);
  const checkNet = usd - gasUsd;
  const net = Math.min(checkNet, Number.isFinite(modelNetUsd) ? modelNetUsd : checkNet);
  if (!(net >= minUsd)) return no(`real check: only $${checkNet.toFixed(2)} after gas (under the $${minUsd.toFixed(2)} minimum)`, checkNet <= 0);
  return { send: true, netUsd: net, why: '', blockPair: false };
}
