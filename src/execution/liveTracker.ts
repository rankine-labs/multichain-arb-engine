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
}

export interface LiveTrackerDeps {
  provider: Pick<ethers.JsonRpcProvider, 'getTransactionReceipt'>;
  ethUsd: () => number;                               // price of the gas coin
  tokenUsd: (token: string, raw: bigint) => number | null; // USD value of a raw token amount
  recordLoss: (usd: number) => void;                  // safety gate daily loss cap
  noteGasUsed: (gas: bigint) => void;                 // adaptive gas limit
  notify: (html: string) => Promise<void> | void;     // Telegram
  pollMs?: number;
  timeoutMs?: number;
  onSettled?: (hash: string) => void;   // receipt arrived or gave up (release the pending-loss hold)
  onDropped?: () => void;               // never mined: resync the nonce
}

export class LiveTradeTracker {
  results: LiveResult[] = [];
  constructor(private readonly d: LiveTrackerDeps) {}

  track(hash: string, meta: { expectedProfitUsd: number; label: string }) {
    void this.watch(hash, meta);
  }

  private async watch(hash: string, meta: { expectedProfitUsd: number; label: string }) {
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
    const r: LiveResult = { hash, label: meta.label, status: 'dropped', gasUsd: 0, expectedProfitUsd: meta.expectedProfitUsd };
    this.results.push(r);
    await this.d.notify(`⚪ <b>TRADE DROPPED</b> · ${meta.label}\nNever mined within ${Math.round((this.d.timeoutMs ?? 90_000) / 1000)}s · no cost`);
  }

  // Pure-ish: turns a receipt into a result (exported for tests via record()).
  record(hash: string, meta: { expectedProfitUsd: number; label: string }, receipt: Pick<ethers.TransactionReceipt, 'status' | 'gasUsed' | 'gasPrice' | 'logs'>) {
    const gasWei = receipt.gasUsed * (receipt.gasPrice ?? 0n);
    const gasUsd = Number(ethers.formatEther(gasWei)) * this.d.ethUsd();
    this.d.noteGasUsed(receipt.gasUsed);
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
      this.results.push({ hash, label: meta.label, status: 'profit', gasUsd, profitTokenUnits, profitUsd, expectedProfitUsd: meta.expectedProfitUsd });
      void this.d.notify(`✅ <b>TRADE WON</b> · ${meta.label}\nProfit ${profitUsd !== undefined ? '$' + profitUsd.toFixed(2) : '?'} · gas $${gasUsd.toFixed(2)} · expected $${meta.expectedProfitUsd.toFixed(2)}\n<code>${hash}</code>`);
    } else {
      // Reverted: someone was faster or the price moved. Only gas is lost.
      this.d.recordLoss(gasUsd);
      this.results.push({ hash, label: meta.label, status: 'reverted', gasUsd, expectedProfitUsd: meta.expectedProfitUsd });
      void this.d.notify(`❌ <b>TRADE REVERTED</b> · ${meta.label}\nLost the race or price moved · gas $${gasUsd.toFixed(2)}\n<code>${hash}</code>`);
    }
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
