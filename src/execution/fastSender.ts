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

export function safetyConfigFromEnv(env: Record<string, string | undefined> = process.env): SafetyConfig {
  return {
    maxTradeUsd: Number(env.MAX_TRADE_USD ?? 5_000),
    dailyLossCapUsd: Number(env.DAILY_LOSS_CAP_USD ?? 25),
    maxSendsPerMinute: Number(env.MAX_SENDS_PER_MIN ?? 6),
    killFile: env.KILL_FILE ?? 'data/KILL',
  };
}

// Every limit must be a positive, finite number. A typo like "5,000" reads as
// NaN, and every comparison with NaN is false, which used to switch the limit
// OFF. Now a bad setting blocks ALL sends instead (fail closed).
export function safetyConfigProblems(cfg: SafetyConfig): string[] {
  const bad: string[] = [];
  const check = (name: string, v: number) => { if (!(Number.isFinite(v) && v > 0)) bad.push(`${name}=${v}`); };
  check('MAX_TRADE_USD', cfg.maxTradeUsd);
  check('DAILY_LOSS_CAP_USD', cfg.dailyLossCapUsd);
  check('MAX_SENDS_PER_MIN', cfg.maxSendsPerMinute);
  return bad;
}

// KILL_SWITCH accepts on / true / 1 / yes in any case.
export const killSwitchOn = (v: string | undefined) => /^(on|true|1|yes)$/i.test((v ?? '').trim());

export class SafetyGate {
  private allowed = new Set<string>();
  private sendTimes: number[] = [];
  private lossUsd = 0;
  private lossDay = '';

  readonly problems: string[];
  constructor(private readonly cfg: SafetyConfig, private readonly now: () => number = Date.now) {
    this.problems = safetyConfigProblems(cfg);
  }

  allowTokens(tokens: string[]) { for (const t of tokens) this.allowed.add(t.toLowerCase()); }
  isAllowed(token: string) { return this.allowed.has(token.toLowerCase()); }

  private today() { return new Date(this.now()).toISOString().slice(0, 10); }

  // Gas a sent trade COULD still cost, counted against the daily cap until
  // its receipt arrives (receipts take up to 90 s; without this the cap could
  // be overshot by every trade in flight).
  private pending = new Map<string, number>();
  reservePending(id: string, usd: number) { if (usd > 0 && Number.isFinite(usd)) this.pending.set(id, usd); }
  releasePending(id: string) { this.pending.delete(id); }
  private pendingUsd() { let s = 0; for (const v of this.pending.values()) s += v; return s; }

  // Gas burned or money lost on a send (dry runs record 0).
  recordLoss(usd: number) {
    if (this.lossDay !== this.today()) { this.lossDay = this.today(); this.lossUsd = 0; }
    this.lossUsd += Math.max(0, usd);
  }

  check(trade: { tradeSizeUsd: number; tokens: string[] }): { ok: true } | { ok: false; reason: string } {
    if (killSwitchOn(process.env.KILL_SWITCH) || existsSync(this.cfg.killFile)) return { ok: false, reason: 'kill switch on' };
    if (this.problems.length) return { ok: false, reason: `bad safety setting: ${this.problems.join(', ')}` };
    if (!(trade.tradeSizeUsd > 0)) return { ok: false, reason: 'no trade size' };
    if (trade.tradeSizeUsd > this.cfg.maxTradeUsd) return { ok: false, reason: `size $${Math.round(trade.tradeSizeUsd)} over max $${this.cfg.maxTradeUsd}` };
    const lostToday = (this.lossDay === this.today() ? this.lossUsd : 0) + this.pendingUsd();
    if (lostToday >= this.cfg.dailyLossCapUsd) return { ok: false, reason: `daily loss cap $${this.cfg.dailyLossCapUsd} reached` };
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
  latestBlock = 0;              // last block number seen (see deadlineBlock)
  private latestBlockAtMs = 0;  // when we saw it
  private blockMs = 50;         // measured average block time (starts at 50 ms, learned from reads)
  private l1Gas = 0n;           // extra gas for posting calldata to the parent chain
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
    if (block?.number) {
      const now = Date.now();
      // Learn the real block time from consecutive reads (smoothed).
      if (this.latestBlock && block.number > this.latestBlock && this.latestBlockAtMs) {
        const per = (now - this.latestBlockAtMs) / (block.number - this.latestBlock);
        if (per > 10 && per < 5_000) this.blockMs = this.blockMs * 0.8 + per * 0.2;
      }
      this.latestBlock = block.number;
      this.latestBlockAtMs = now;
    }
    // Arbitrum/Orbit: gas used includes the cost of posting the calldata to
    // the parent chain, which rises when that chain's fee spikes. Ask the
    // NodeInterface (0xC8) what a typical trade's calldata costs right now.
    this.refreshL1Gas().catch(() => { /* keep last value */ });
    const base = block?.baseFeePerGas ?? (await this.readProvider.getFeeData()).gasPrice ?? 0n;
    // 2x base fee headroom: Robinhood orders first come, first served, so a
    // priority tip buys nothing; the cap just has to cover base-fee moves.
    this.maxFeePerGas = base * 2n + 1n;
  }

  // Parent-chain (L1) part of the gas for ~1 KB of calldata, from
  // NodeInterface.gasEstimateL1Component. Only meaningful on Arbitrum/Orbit
  // chains; elsewhere the call fails and the extra stays 0.
  private l1Tick = 0;
  private async refreshL1Gas() {
    if (this.l1Tick++ % 5 !== 0) return; // every ~10 s is plenty
    const iface = new ethers.Interface(['function gasEstimateL1Component(address,bool,bytes) returns (uint64,uint256,uint256)']);
    const data = iface.encodeFunctionData('gasEstimateL1Component', [ethers.ZeroAddress, false, '0x' + 'ab'.repeat(1_000)]);
    const ret = await this.readProvider.call({ to: '0x00000000000000000000000000000000000000C8', data });
    const [l1] = iface.decodeFunctionResult('gasEstimateL1Component', ret);
    this.l1Gas = BigInt(l1);
  }

  // Deadline for a trade: the current block (estimated from the last read
  // plus elapsed time, since blocks are fast and reads every 2 s) plus a
  // margin. The margin is TIME-based by default (MAX_BLOCK_MARGIN_MS, 3 s
  // worth of blocks at the measured block time), because Robinhood blocks
  // turned out to be ~30 ms, not 100 ms: a fixed block count would be far
  // shorter than intended. MAX_BLOCK_MARGIN (blocks) overrides it.
  // null = block info too old to trust: do not send.
  deadlineBlock(marginBlocks?: number, now = Date.now()): bigint | null {
    if (!this.latestBlock || !this.latestBlockAtMs) return null;
    const age = now - this.latestBlockAtMs;
    if (age > 10_000) return null;
    const est = this.latestBlock + Math.floor(age / this.blockMs);
    const envBlocks = process.env.MAX_BLOCK_MARGIN ? Number(process.env.MAX_BLOCK_MARGIN) : undefined;
    const marginMs = Number(process.env.MAX_BLOCK_MARGIN_MS ?? 3_000);
    let margin = marginBlocks ?? envBlocks ?? Math.ceil(marginMs / this.blockMs);
    if (!(Number.isFinite(margin) && margin >= 1)) margin = Math.ceil(3_000 / this.blockMs);
    return BigInt(est + Math.floor(margin));
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
  // Expected USD gas cost of one trade at current prices: gas a trade
  // actually uses (most seen, or 450k before the first receipt) + L1 posting
  // gas, at the current base fee (maxFeePerGas is 2x base). null if gas
  // price or ETH price is unknown.
  gasCostUsd(ethUsd: number | null | undefined): number | null {
    if (!this.maxFeePerGas || !ethUsd || !(ethUsd > 0)) return null;
    const used = (this.maxGasSeen > 0n ? this.maxGasSeen : 450_000n) + this.l1Gas;
    const baseFee = this.maxFeePerGas / 2n;
    return (Number(used * baseFee) / 1e18) * ethUsd;
  }

  // Limit actually used: tuned L2 limit + 1.5x the current L1 posting gas.
  get currentGasLimit() { return this.gasLimitNow + (this.l1Gas * 3n) / 2n; }

  // Live only: can the wallet pay for one trade at the gas cap? (ETH wei)
  async balanceCheck(): Promise<{ ok: boolean; balance: bigint; needed: bigint }> {
    const balance = await this.readProvider.getBalance(this.wallet.address);
    const needed = (this.maxFeePerGas ?? 0n) * this.currentGasLimit;
    return { ok: balance >= needed, balance, needed };
  }

  get ready() { return this.maxFeePerGas !== null && this.nonce !== null; }

  // After a sent trade was DROPPED (never mined), its nonce was never used:
  // re-read the count from the chain so later trades don't queue behind the
  // gap. Runs in the fire queue so it can't race a send.
  resyncNonce(): Promise<void> {
    const run = this.fireChain.then(async () => {
      if (!this.live) return;
      const remote = await this.readProvider.getTransactionCount(this.wallet.address, 'pending').catch(() => null);
      if (remote !== null) this.nonce = remote;
    });
    this.fireChain = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  // Fires run one at a time (sign ~1 ms + send ~5 ms), so two triggers can
  // never sign with the same nonce. Each fire waits for the previous one.
  private fireChain: Promise<unknown> = Promise.resolve();
  fire(to: string, data: string): Promise<FireResult> {
    const run = this.fireChain.then(() => this.fireOne(to, data), () => this.fireOne(to, data));
    this.fireChain = run.catch(() => undefined);
    return run;
  }

  private async fireOne(to: string, data: string): Promise<FireResult> {
    if (!this.ready) return { live: this.live, signMs: 0, error: 'sender not ready' };
    const t0 = performance.now();
    const n = this.nonce!;
    const tx: ethers.TransactionRequest = {
      type: 2, chainId: this.chainId, nonce: n, to, data, value: 0n,
      gasLimit: this.currentGasLimit, maxFeePerGas: this.maxFeePerGas!, maxPriorityFeePerGas: 0n,
    };
    const raw = await this.wallet.signTransaction(tx);
    const signMs = performance.now() - t0;
    if (!this.live) return { live: false, signMs };

    // LIVE: one raw send; nonce advanced locally on success.
    const t1 = performance.now();
    try {
      const hash = await this.sendProvider.send('eth_sendRawTransaction', [raw]) as string;
      this.nonce = n + 1;
      return { live: true, signMs, sendMs: performance.now() - t1, txHash: hash };
    } catch (err) {
      const msg = String((err as Error).message);
      // Resync, but never go BELOW the nonce we just tried: the read node can
      // lag. "nonce too low" means n is already used, so move past it.
      const remote = await this.readProvider.getTransactionCount(this.wallet.address, 'pending').catch(() => n);
      const floor = /nonce too low|already known/i.test(msg) ? n + 1 : n;
      this.nonce = Math.max(remote, floor);
      return { live: true, signMs, sendMs: performance.now() - t1, error: msg.slice(0, 200) };
    }
  }
}
