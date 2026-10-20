import { ethers } from 'ethers';

// ============================================================================
// LIVE TRADE TRACKER -- what actually happened to each real trade we sent
//
// Plain English:
//   After a live send, we wait for the receipt and record:
//     - did it land and profit (ArbExecutor's Executed event gives the exact
//       profit), or revert (someone beat us / price moved: we just pay gas)?
//     - how much gas it cost in USD
//   Losses (gas on reverts) feed the safety gate's daily loss cap, every
//   result goes to Telegram, and observed gas use tunes the gas limit.
//   Only used in live mode; dry runs never create a transaction.
// ============================================================================

const EXECUTED_TOPIC = ethers.id('Executed(address,uint256,uint256,bool)');

export interface LiveResult {
  hash: string;
  label: string;
  status: 'profit' | 'reverted' | 'dropped';
  gasUsd: number;
  profitTokenUnits?: bigint;  // raw profit from the Executed event
  profitUsd?: number;
  expectedProfitUsd: number;
  sizeUsd?: number;           // dollars put in (from the send), for the live Telegram message
  funding?: Funding;          // how it was paid for: own money or a flash loan (and its fee)
}

// How a live trade was paid for (Oct 20, flash loans on). feePct: the lender's
// fee in percent (0.01 = 0.01%); feeUsd: that fee on this trade in dollars.
// The contract's reported profit is already AFTER the loan fee.
export interface Funding { kind: 'own' | 'flash'; feePct?: number; feeUsd?: number }

export interface LiveTrackerDeps {
  provider: Pick<ethers.JsonRpcProvider, 'getTransactionReceipt'>;
  ethUsd: () => number;                               // price of the gas coin
  tokenUsd: (token: string, raw: bigint) => number | null; // USD value of a raw token amount
  recordLoss: (usd: number) => void;                  // safety gate daily loss cap
  // Adaptive gas limit + gas calibration. `info` (added Oct 13): which trade
  // it was, its kind of route (core/gasModel.ts key) and whether it succeeded.
  noteGasUsed: (gas: bigint, info?: { hash: string; routeKey?: string; success: boolean }) => void;
  notify: (html: string) => Promise<void> | void;     // Telegram
  pollMs?: number;
  timeoutMs?: number;
  onSettled?: (hash: string) => void;   // receipt arrived or gave up (release the pending-loss hold)
  onDropped?: () => void;               // never mined: resync the nonce
  onResult?: (r: LiveResult) => void;   // every final result (written to data/live-trades.jsonl for the status page)
}

export class LiveTradeTracker {
  results: LiveResult[] = [];
  constructor(private readonly d: LiveTrackerDeps) {}

  // routeKey (optional): the gas model's name for this kind of trade, so its
  // real gas can calibrate future estimates.
  track(hash: string, meta: { expectedProfitUsd: number; label: string; routeKey?: string; sizeUsd?: number; funding?: Funding }) {
    void this.watch(hash, meta);
  }

  private async watch(hash: string, meta: { expectedProfitUsd: number; label: string; routeKey?: string; sizeUsd?: number; funding?: Funding }) {
    const poll = this.d.pollMs ?? 1_000, deadline = Date.now() + (this.d.timeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      let receipt: ethers.TransactionReceipt | null = null;
      try { receipt = await this.d.provider.getTransactionReceipt(hash); } catch { /* retry */ }
      if (receipt) { this.d.onSettled?.(hash); this.record(hash, meta, receipt); return; }
      await new Promise((r) => setTimeout(r, poll));
    }
    // Never mined: no gas paid, but worth knowing. Its nonce is free again.
    this.d.onSettled?.(hash);
    this.d.onDropped?.();
    const r: LiveResult = { hash, label: meta.label, status: 'dropped', gasUsd: 0, expectedProfitUsd: meta.expectedProfitUsd, sizeUsd: meta.sizeUsd, funding: meta.funding };
    this.push(r);
    await this.d.notify(`⚪ <b>TRADE DROPPED</b> · ${meta.label}\nNever mined within ${Math.round((this.d.timeoutMs ?? 90_000) / 1000)}s · no cost`);
  }

  // Pure-ish: turns a receipt into a result (exported for tests via record()).
  record(hash: string, meta: { expectedProfitUsd: number; label: string; routeKey?: string; sizeUsd?: number; funding?: Funding }, receipt: Pick<ethers.TransactionReceipt, 'status' | 'gasUsed' | 'gasPrice' | 'logs'>) {
    const gasWei = receipt.gasUsed * (receipt.gasPrice ?? 0n);
    const gasUsd = Number(ethers.formatEther(gasWei)) * this.d.ethUsd();
    this.d.noteGasUsed(receipt.gasUsed, { hash, routeKey: meta.routeKey, success: receipt.status === 1 });
    if (receipt.status === 1) {
      const ev = receipt.logs.find((l) => l.topics[0] === EXECUTED_TOPIC);
      let profitTokenUnits: bigint | undefined, profitUsd: number | undefined;
      if (ev) {
        const token = ethers.getAddress('0x' + ev.topics[1].slice(26));
        const words = ev.data.slice(2).match(/.{64}/g) ?? [];
        profitTokenUnits = words[1] ? BigInt('0x' + words[1]) : undefined;
        if (profitTokenUnits !== undefined) profitUsd = this.d.tokenUsd(token, profitTokenUnits) ?? undefined;
      }
      const net = (profitUsd ?? 0) - gasUsd;
      if (net < 0) this.d.recordLoss(-net);
      this.push({ hash, label: meta.label, status: 'profit', gasUsd, profitTokenUnits, profitUsd, expectedProfitUsd: meta.expectedProfitUsd, sizeUsd: meta.sizeUsd, funding: meta.funding });
      void this.d.notify(`✅ <b>TRADE WON</b> · ${meta.label}\nProfit ${profitUsd !== undefined ? '$' + profitUsd.toFixed(2) : '?'} · gas $${gasUsd.toFixed(2)} · expected $${meta.expectedProfitUsd.toFixed(2)}\n<code>${hash}</code>`);
    } else {
      // Reverted: someone was faster or the price moved. Only gas is lost.
      this.d.recordLoss(gasUsd);
      this.push({ hash, label: meta.label, status: 'reverted', gasUsd, expectedProfitUsd: meta.expectedProfitUsd, sizeUsd: meta.sizeUsd, funding: meta.funding });
      void this.d.notify(`❌ <b>TRADE REVERTED</b> · ${meta.label}\nLost the race or price moved · gas $${gasUsd.toFixed(2)}\n<code>${hash}</code>`);
    }
  }

  // Keep the result and tell the listener (never lets a listener error escape).
  private push(r: LiveResult) {
    this.results.push(r);
    try { this.d.onResult?.(r); } catch { /* logging must never affect trading */ }
  }

  summary() {
    const won = this.results.filter((r) => r.status === 'profit');
    return {
      sent: this.results.length, won: won.length,
      reverted: this.results.filter((r) => r.status === 'reverted').length,
      profitUsd: won.reduce((s, r) => s + (r.profitUsd ?? 0), 0),
      gasUsd: this.results.reduce((s, r) => s + r.gasUsd, 0),
    };
  }
  reset() { this.results = []; }
}
