import { ethers } from 'ethers';
import { existsSync } from 'fs';

// ============================================================================
// FAST SENDER + SAFETY GATE
//
// Plain English:
//   Turning a decision into a signed transaction must take ~1 ms, not 100.
//   So everything that can be known in advance IS known in advance: the
//   chain id, the wallet's next nonce, and current gas prices (refreshed in
//   the background every 2 s). At fire time we only fill in the calldata,
//   sign locally, and (when live) send.
//
//   DRY RUN BY DEFAULT. It signs with a throwaway key and never broadcasts.
//   Going live needs ALL of:
//     EXECUTION_ENABLED=true
//     LIVE_SEND_CONFIRM=yes-real-money
//     BOT_PRIVATE_KEY=<hot wallet key>       (gas only; trades use flash loans)
//     ARB_EXECUTOR_ROBINHOOD=<deployed ArbExecutor>
//   and the safety gate passing for that trade.
//
// SAFETY GATE (checked before every send, live or dry):
//   - kill switch: file data/KILL exists, or KILL_SWITCH=on
//   - max trade size (MAX_TRADE_USD, default 5,000)
//   - daily loss cap (DAILY_LOSS_CAP_USD, default 25): gas burned on failed
//     sends + any losses; once hit, no more sends until midnight UTC
//   - max sends per minute (MAX_SENDS_PER_MIN, default 6)
//   - token allowlist: only tokens from pairs we've vetted (scan's top pairs)
// ============================================================================

export interface SafetyConfig {
  maxTradeUsd: number;
  dailyLossCapUsd: number;
  maxSendsPerMinute: number;
  killFile: string;
}

export function safetyConfigFromEnv(): SafetyConfig {
  return {
    maxTradeUsd: Number(process.env.MAX_TRADE_USD ?? 5_000),
    dailyLossCapUsd: Number(process.env.DAILY_LOSS_CAP_USD ?? 25),
    maxSendsPerMinute: Number(process.env.MAX_SENDS_PER_MIN ?? 6),
    killFile: process.env.KILL_FILE ?? 'data/KILL',
  };
}

export class SafetyGate {
  private allowed = new Set<string>();
  private sendTimes: number[] = [];
  private lossUsd = 0;
  private lossDay = '';

  constructor(private readonly cfg: SafetyConfig, private readonly now: () => number = Date.now) {}

  allowTokens(tokens: string[]) { for (const t of tokens) this.allowed.add(t.toLowerCase()); }

  private today() { return new Date(this.now()).toISOString().slice(0, 10); }

  // Gas burned or money lost on a send (dry runs record 0).
  recordLoss(usd: number) {
    if (this.lossDay !== this.today()) { this.lossDay = this.today(); this.lossUsd = 0; }
    this.lossUsd += Math.max(0, usd);
  }

  check(trade: { tradeSizeUsd: number; tokens: string[] }): { ok: true } | { ok: false; reason: string } {
    if (process.env.KILL_SWITCH === 'on' || existsSync(this.cfg.killFile)) return { ok: false, reason: 'kill switch on' };
    if (!(trade.tradeSizeUsd > 0)) return { ok: false, reason: 'no trade size' };
    if (trade.tradeSizeUsd > this.cfg.maxTradeUsd) return { ok: false, reason: `size $${Math.round(trade.tradeSizeUsd)} over max $${this.cfg.maxTradeUsd}` };
    if (this.lossDay === this.today() && this.lossUsd >= this.cfg.dailyLossCapUsd) return { ok: false, reason: `daily loss cap $${this.cfg.dailyLossCapUsd} reached` };
    const bad = trade.tokens.find((t) => !this.allowed.has(t.toLowerCase()));
    if (bad) return { ok: false, reason: `token ${bad.slice(0, 10)} not on the allowlist` };
    const t = this.now();
    this.sendTimes = this.sendTimes.filter((x) => t - x < 60_000);
    if (this.sendTimes.length >= this.cfg.maxSendsPerMinute) return { ok: false, reason: 'send rate limit' };
    this.sendTimes.push(t);
    return { ok: true };
  }
}

export interface FireResult {
  live: boolean;
  signMs: number;      // time to build + sign
  sendMs?: number;     // time for the send call (live only)
  txHash?: string;
  error?: string;
}

export class FastSender {
  private wallet: ethers.Wallet | ethers.HDNodeWallet;
  private nonce: number | null = null;
  private maxFeePerGas: bigint | null = null;
  latestBlock = 0;              // for trade deadlines (maxBlock)
  private gasLimitNow: bigint;  // starts at FIRE_GAS_LIMIT, tuned from real receipts
  private maxGasSeen = 0n;
  private gasTimer: NodeJS.Timeout | null = null;
  readonly live: boolean;

  constructor(
    private readonly readProvider: ethers.JsonRpcProvider,
    private readonly chainId: number,
    private readonly sendProvider: ethers.JsonRpcProvider = readProvider,
    private readonly gasLimit = BigInt(process.env.FIRE_GAS_LIMIT ?? 1_500_000),
  ) {
    this.gasLimitNow = gasLimit;
    const key = process.env.BOT_PRIVATE_KEY;
    this.live = process.env.EXECUTION_ENABLED === 'true' && process.env.LIVE_SEND_CONFIRM === 'yes-real-money' && !!key;
    // Dry run signs with a throwaway key: same work, nothing at stake.
    this.wallet = this.live ? new ethers.Wallet(key!) : ethers.Wallet.createRandom();
  }

  get address() { return this.wallet.address; }

  // Pre-load nonce and gas, then keep gas fresh in the background.
  async start() {
    await this.refreshGas();
    this.nonce = this.live ? await this.readProvider.getTransactionCount(this.wallet.address, 'pending') : 0;
    this.gasTimer = setInterval(() => { this.refreshGas().catch(() => { /* keep last value */ }); }, 2_000);
    // Keep the connection to the send endpoint warm (TCP + TLS already open
    // when a trade fires, instead of paying a fresh handshake: ~1 round trip
    // saved). Any reply, even an error, keeps the connection alive.
    this.warmTimer = setInterval(() => {
      try { this.sendProvider.send('eth_chainId', []).catch(() => { /* fine */ }); } catch { /* fine */ }
    }, 4_000);
  }
  private warmTimer: NodeJS.Timeout | null = null;

  stop() { if (this.gasTimer) clearInterval(this.gasTimer); if (this.warmTimer) clearInterval(this.warmTimer); }

  private async refreshGas() {
    const block = await this.readProvider.getBlock('latest');
    if (block?.number) this.latestBlock = block.number;
    const base = block?.baseFeePerGas ?? (await this.readProvider.getFeeData()).gasPrice ?? 0n;
    // 2x base fee headroom: Robinhood orders first come, first served, so a
    // priority tip buys nothing; the cap just has to cover base-fee moves.
    this.maxFeePerGas = base * 2n + 1n;
  }

  // Gas limit follows what real trades used: 1.5x the most seen, never below
  // half the configured default. You only pay for gas USED; the limit just
  // has to be high enough not to run out mid-trade.
  noteGasUsed(gas: bigint) {
    if (gas > this.maxGasSeen) this.maxGasSeen = gas;
    const tuned = (this.maxGasSeen * 3n) / 2n;
    const floor = this.gasLimit / 2n;
    this.gasLimitNow = tuned > floor ? tuned : floor;
  }
  get currentGasLimit() { return this.gasLimitNow; }

  // Live only: can the wallet pay for one trade at the gas cap? (ETH wei)
  async balanceCheck(): Promise<{ ok: boolean; balance: bigint; needed: bigint }> {
    const balance = await this.readProvider.getBalance(this.wallet.address);
    const needed = (this.maxFeePerGas ?? 0n) * this.gasLimitNow;
    return { ok: balance >= needed, balance, needed };
  }

  get ready() { return this.maxFeePerGas !== null && this.nonce !== null; }

  async fire(to: string, data: string): Promise<FireResult> {
    if (!this.ready) return { live: this.live, signMs: 0, error: 'sender not ready' };
    const t0 = performance.now();
    const tx: ethers.TransactionRequest = {
      type: 2, chainId: this.chainId, nonce: this.nonce!, to, data, value: 0n,
      gasLimit: this.gasLimitNow, maxFeePerGas: this.maxFeePerGas!, maxPriorityFeePerGas: 0n,
    };
    const raw = await this.wallet.signTransaction(tx);
    const signMs = performance.now() - t0;
    if (!this.live) return { live: false, signMs };

    // LIVE: one raw send, nonce advanced locally; resync nonce on any error.
    const t1 = performance.now();
    try {
      const hash = await this.sendProvider.send('eth_sendRawTransaction', [raw]) as string;
      this.nonce!++;
      return { live: true, signMs, sendMs: performance.now() - t1, txHash: hash };
    } catch (err) {
      this.nonce = await this.readProvider.getTransactionCount(this.wallet.address, 'pending').catch(() => this.nonce);
      return { live: true, signMs, sendMs: performance.now() - t1, error: String((err as Error).message).slice(0, 200) };
    }
  }
}
