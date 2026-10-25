import { ethers } from 'ethers';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { labelled, markStretch } from '../core/stallFinder';

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
//   - max trade size (MAX_TRADE_USD, default 20,000; was 5,000 until Oct 11)
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
    maxTradeUsd: Number(env.MAX_TRADE_USD ?? 20_000),
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
  // Take coins off the allowlist (an auto-vetted coin that later failed like a trap coin).
  disallowTokens(tokens: string[]) { for (const t of tokens) this.allowed.delete(t.toLowerCase()); }
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

  // Money lost today so far (UTC day, resets at midnight UTC like the cap).
  // includePending: also count trades still waiting for a receipt, which is
  // what check() compares against the cap. Used by the Telegram safety alerts.
  lossTodayUsd(includePending = false): number {
    return (this.lossDay === this.today() ? this.lossUsd : 0) + (includePending ? this.pendingUsd() : 0);
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

// IN-FLIGHT MARKER (deploy lock, Oct 13)
//
// Plain English:
//   While live, auto-deploy must not restart the bot in the middle of a real
//   trade. So the bot keeps a tiny file, data/inflight.json, saying how many
//   live trades are sent but not finished yet (no receipt / not given up):
//     {"count":1,"since":"2026-10-16T14:00:00.000Z","sinceMs":1760623200000}
//   auto-deploy.sh waits for count 0 before restarting. Only switched on for
//   the real bot (shadowMain calls trackInflight), and only when live, so
//   tests and practice mode never write it.
//   Starts at count 0 on every bot start: a crash mid-trade can't leave a
//   stuck count behind (auto-deploy also ignores a file untouched for 5 min).
export class InflightMarker {
  private hashes = new Set<string>();
  private sinceMs = 0;
  constructor(readonly file: string, private readonly now: () => number = Date.now) { this.write(); }

  get count() { return this.hashes.size; }
  add(hash: string) {
    if (this.hashes.size === 0) this.sinceMs = this.now();
    this.hashes.add(hash);
    this.write();
  }
  remove(hash: string) {
    if (!this.hashes.delete(hash)) return;
    if (this.hashes.size === 0) this.sinceMs = 0;
    this.write();
  }
  // Write to a temp file then rename, so auto-deploy never reads half a file.
  // Never throws: a disk problem must not stop a trade.
  private write() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const body = JSON.stringify({ count: this.hashes.size, since: this.sinceMs ? new Date(this.sinceMs).toISOString() : null, sinceMs: this.sinceMs });
      writeFileSync(this.file + '.tmp', body + '\n');
      renameSync(this.file + '.tmp', this.file);
    } catch { /* best effort */ }
  }
}

export interface FireResult {
  live: boolean;
  signMs: number;      // time to build + sign
  sendMs?: number;     // time for the send call (live only)
  queueMs?: number;    // time spent waiting for our turn (previous fire / nonce re-sync)
  signedAtMs?: number; // wall-clock time the trade was signed (fire-ready = this - trade seen)
  nonce?: number;      // nonce used (live only)
  txHash?: string;
  error?: string;
}

// PARALLEL SEND (SPEED_PARALLEL_SEND). Default OFF: see FastSender.fire().
export const parallelSendFromEnv = (env: Record<string, string | undefined> = process.env) => env.SPEED_PARALLEL_SEND === '1' || env.SPEED_PARALLEL_SEND === 'on';

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
  readonly parallel: boolean;
  private readonly log: (line: string) => void;

  constructor(
    private readonly readProvider: ethers.JsonRpcProvider,
    private readonly chainId: number,
    private readonly sendProvider: ethers.JsonRpcProvider = readProvider,
    private readonly gasLimit = BigInt(process.env.FIRE_GAS_LIMIT ?? 1_500_000),
    // parallel: see fire(). Defaults to SPEED_PARALLEL_SEND (off).
    opts: { parallel?: boolean; log?: (line: string) => void } = {},
  ) {
    this.parallel = opts.parallel ?? parallelSendFromEnv();
    this.log = opts.log ?? ((l) => console.log(l));
    this.gasLimitNow = gasLimit;
    const key = process.env.BOT_PRIVATE_KEY;
    this.live = process.env.EXECUTION_ENABLED === 'true' && process.env.LIVE_SEND_CONFIRM === 'yes-real-money' && !!key;
    // Dry run signs with a throwaway key: same work, nothing at stake.
    this.wallet = this.live ? new ethers.Wallet(key!) : ethers.Wallet.createRandom();
  }

  get address() { return this.wallet.address; }

  // Deploy lock: count live trades in flight in this file (see InflightMarker).
  // Live only; practice mode writes nothing. settled() = receipt arrived or
  // the trade was given up as dropped.
  private inflight: InflightMarker | null = null;
  trackInflight(file: string) { if (this.live) this.inflight = new InflightMarker(file); }
  settled(hash: string) { this.inflight?.remove(hash); }

  // Pre-load nonce and gas, then keep gas fresh in the background.
  async start() {
    await this.refreshGas();
    this.nonce = this.live ? await this.readProvider.getTransactionCount(this.wallet.address, 'pending') : 0;
    this.maxAccepted = this.nonce - 1; // everything below the chain's count is already used
    // (Stall finder names only: measurement, nothing about sending changes.)
    this.gasTimer = setInterval(labelled('gas price read', () => { this.refreshGas().catch(() => { /* keep last value */ }); }), 2_000);
    // Keep the connection to the send endpoint warm (TCP + TLS already open
    // when a trade fires, instead of paying a fresh handshake: ~1 round trip
    // saved). Any reply, even an error, keeps the connection alive.
    this.warmTimer = setInterval(() => {
      try { this.sendProvider.send('eth_chainId', []).catch(() => { /* fine */ }); } catch { /* fine */ }
    }, Math.max(250, Number(process.env.SEND_WARM_MS ?? 1_000)));
    // SEND_WARM_MS (Oct 25): every 1 s (was 4 s, right at the usual 4 s idle
    // close of a kept-alive connection, so a trade could still pay a fresh
    // TCP + TLS handshake: ~20-25 ms measured to the sequencer).
  }
  private warmTimer: NodeJS.Timeout | null = null;

  stop() { if (this.gasTimer) clearInterval(this.gasTimer); if (this.warmTimer) clearInterval(this.warmTimer); }

  private async refreshGas() {
    const block = await this.readProvider.getBlock('latest');
    markStretch('gas price read');
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

  // Parent-chain (L1) part of the gas for one trade's calldata, from
  // NodeInterface.gasEstimateL1Component. Only meaningful on Arbitrum/Orbit
  // chains; elsewhere the call fails and the extra stays 0.
  //
  // Review fix (Oct 13): this used to ask about 1,000 copies of the byte 0xab.
  // The parent chain charges for data AFTER compression, and a repeated byte
  // compresses to almost nothing, so the estimate was far too low. Now it
  // asks about RANDOM bytes (which don't compress) of our real trade size:
  // a 2-pool executor call is 772 bytes (measured from encodeExecuteRaw), so
  // FIRE_L1_CALLDATA_BYTES defaults to 800. Real calldata (many zero bytes)
  // compresses somewhat, so this errs on the high side.
  private l1Tick = 0;
  private readonly l1Bytes = (() => {
    const n = Number(process.env.FIRE_L1_CALLDATA_BYTES ?? 800);
    return Number.isInteger(n) && n >= 100 && n <= 20_000 ? n : 800;
  })();
  private async refreshL1Gas() {
    if (this.l1Tick++ % 5 !== 0) return; // every ~10 s is plenty
    const iface = new ethers.Interface(['function gasEstimateL1Component(address,bool,bytes) returns (uint64,uint256,uint256)']);
    const data = iface.encodeFunctionData('gasEstimateL1Component', [ethers.ZeroAddress, false, ethers.hexlify(ethers.randomBytes(this.l1Bytes))]);
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

  // Same, for a given amount of gas (e.g. our measured own-money vs loan
  // trade). Used by the hourly report to show our real cost per trade.
  gasCostUsdFor(gasUnits: bigint, ethUsd: number | null | undefined): number | null {
    if (!this.maxFeePerGas || !ethUsd || !(ethUsd > 0)) return null;
    return (Number((gasUnits + this.l1Gas) * (this.maxFeePerGas / 2n)) / 1e18) * ethUsd;
  }

  // Current parent-chain posting gas estimate for one trade (gas units), for
  // comparing with real receipts' gasUsedForL1.
  get l1GasNow(): bigint { return this.l1Gas; }

  // When the gas price was last read successfully (0 = never). The gas model
  // (core/gasModel.ts) stops trusting the live price when this gets old.
  get gasReadAtMs(): number { return this.maxFeePerGas ? this.latestBlockAtMs : 0; }

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
    if (this.parallel) return this.pauseAndResync('dropped trade', null);
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
  //
  // SPEED_PARALLEL_SEND=1 (default OFF) changes only this: the next fire no
  // longer waits for the previous one's eth_sendRawTransaction reply (see
  // fireParallel below). Off = exactly the old one-at-a-time behaviour.
  private fireChain: Promise<unknown> = Promise.resolve();
  fire(to: string, data: string): Promise<FireResult> {
    const calledAt = performance.now();
    if (this.parallel) return this.fireParallel(to, data, calledAt);
    const run = this.fireChain.then(() => this.fireOne(to, data, calledAt), () => this.fireOne(to, data, calledAt));
    this.fireChain = run.catch(() => undefined);
    return run;
  }

  private async fireOne(to: string, data: string, calledAt = performance.now()): Promise<FireResult> {
    if (!this.ready) return { live: this.live, signMs: 0, error: 'sender not ready' };
    const t0 = performance.now();
    const queueMs = t0 - calledAt;
    const n = this.nonce!;
    const tx: ethers.TransactionRequest = {
      type: 2, chainId: this.chainId, nonce: n, to, data, value: 0n,
      gasLimit: this.currentGasLimit, maxFeePerGas: this.maxFeePerGas!, maxPriorityFeePerGas: 0n,
    };
    const raw = await this.wallet.signTransaction(tx);
    const signMs = performance.now() - t0;
    const signedAtMs = Date.now();
    if (!this.live) return { live: false, signMs, queueMs, signedAtMs };

    // LIVE: one raw send; nonce advanced locally on success.
    const t1 = performance.now();
    try {
      const hash = await this.sendProvider.send('eth_sendRawTransaction', [raw]) as string;
      this.nonce = n + 1;
      if (n > this.maxAccepted) this.maxAccepted = n;
      this.inflight?.add(hash);   // marked right AFTER the send so the send itself isn't slowed
      return { live: true, signMs, sendMs: performance.now() - t1, queueMs, signedAtMs, nonce: n, txHash: hash };
    } catch (err) {
      const msg = String((err as Error).message);
      // Resync, but never go BELOW the nonce we just tried: the read node can
      // lag. "nonce too low" means n is already used, so move past it.
      const remote = await this.readProvider.getTransactionCount(this.wallet.address, 'pending').catch(() => n);
      const floor = /nonce too low|already known/i.test(msg) ? n + 1 : n;
      this.nonce = Math.max(remote, floor);
      return { live: true, signMs, sendMs: performance.now() - t1, queueMs, signedAtMs, nonce: n, error: msg.slice(0, 200) };
    }
  }

  // ---- PARALLEL SEND (SPEED_PARALLEL_SEND=1, default OFF) ------------------
  //
  // Plain English:
  //   One-at-a-time mode makes trade #2 wait until trade #1's send call has
  //   come back from the sequencer (~5-20 ms). In parallel mode:
  //     - each fire takes the next nonce INSTANTLY and in strict order (a
  //       plain counter, taken before anything can interrupt), signs, and
  //       sends without making the next fire wait for the reply;
  //     - if ANY send fails, new signing PAUSES. The bot waits for every
  //       send still on its way, then re-reads the wallet's nonce from the
  //       chain and picks the next nonce:
  //         * the LOWEST nonce that failed (re-signed at it, so no hole is
  //           left behind), unless the chain or a "nonce too low" reply says
  //           it is already used;
  //         * otherwise the highest of: what the chain says (pending count),
  //           one past the highest nonce the sequencer ACCEPTED, one past any
  //           nonce reported as already used.
  //       Nonces the sequencer already ACCEPTED are skipped when handing out
  //       the following ones, so an accepted nonce is never used twice.
  //       Every re-sync is logged, so nothing changes silently.
  //   Practice mode never sends, so it behaves exactly as before (same
  //   nonce, signature only).
  //   Safety gates (kill switch, loss cap, rate limit, allowlist) run in
  //   shadowMain BEFORE fire() and are untouched.
  private maxAccepted = -1;                    // highest nonce the sequencer accepted
  private usedFloor = 0;                       // one past a nonce reported as already used
  private failedNonces = new Set<number>();     // nonces that failed (not "already used") since the last re-sync
  private acceptedNonces = new Set<number>();   // accepted nonces at or above the counter (skipped when handing out)
  private sending = new Set<Promise<void>>();  // sends on their way (bookkeeping included)
  private pause: Promise<void> | null = null;  // set while re-syncing: new fires wait

  private async fireParallel(to: string, data: string, calledAt: number): Promise<FireResult> {
    // Wait out any re-sync in progress (loop: a new one may start meanwhile).
    while (this.pause) await this.pause;
    if (!this.ready) return { live: this.live, signMs: 0, error: 'sender not ready' };
    const t0 = performance.now();
    const queueMs = t0 - calledAt;
    // Take the nonce NOW, synchronously, before any await: two fires can
    // never get the same one, and they get them in call order.
    let n = this.nonce!;
    if (this.live) {
      // Skip nonces already accepted (possible right after re-signing a hole).
      while (this.acceptedNonces.has(n)) { this.acceptedNonces.delete(n); n++; }
      for (const a of this.acceptedNonces) if (a < n) this.acceptedNonces.delete(a);
      this.nonce = n + 1;
    }
    // Live: register this nonce as "on its way" from the moment it is taken
    // (not just once it is sent), so a re-sync always waits for it.
    let finish: () => void = () => {};
    const slot = this.live ? new Promise<void>((r) => { finish = r; }) : null;
    if (slot) this.sending.add(slot);
    const release = () => { if (slot) { this.sending.delete(slot); finish(); } };

    const tx: ethers.TransactionRequest = {
      type: 2, chainId: this.chainId, nonce: n, to, data, value: 0n,
      gasLimit: this.currentGasLimit, maxFeePerGas: this.maxFeePerGas!, maxPriorityFeePerGas: 0n,
    };
    let raw: string;
    try {
      raw = await this.wallet.signTransaction(tx);
    } catch (err) {
      // Signing failed: nonce n was never sent. Re-sync so it isn't skipped.
      if (this.live) this.failedNonces.add(n);
      release();
      if (this.live) await this.pauseAndResync(`signing failed for nonce ${n}`, n);
      return { live: this.live, signMs: performance.now() - t0, queueMs, error: `sign failed: ${String((err as Error).message).slice(0, 150)}` };
    }
    const signMs = performance.now() - t0;
    const signedAtMs = Date.now();
    if (!this.live) return { live: false, signMs, queueMs, signedAtMs };

    const t1 = performance.now();
    let hash: string | null = null;
    let msg = '';
    try {
      hash = await this.sendProvider.send('eth_sendRawTransaction', [raw]) as string;
      // Outcome recorded BEFORE this nonce stops counting as "on its way".
      if (n > this.maxAccepted) this.maxAccepted = n;
      this.acceptedNonces.add(n);
      this.inflight?.add(hash);   // marked right AFTER the send so the send itself isn't slowed
    } catch (err) {
      msg = String((err as Error)?.message ?? err);
      // "nonce too low" / "already known": n is used up, never use it again.
      if (/nonce too low|already known/i.test(msg)) this.usedFloor = Math.max(this.usedFloor, n + 1);
      else this.failedNonces.add(n);
    } finally {
      release();
    }
    const sendMs = performance.now() - t1;
    if (hash) return { live: true, signMs, sendMs, queueMs, signedAtMs, nonce: n, txHash: hash };
    await this.pauseAndResync(`send failed for nonce ${n}`, n);
    return { live: true, signMs, sendMs, queueMs, signedAtMs, nonce: n, error: (msg || 'send failed').slice(0, 200) };
  }

  // Pause new signing, wait for every send on its way, then set the next
  // nonce (see the rules above). Several failures at once share ONE re-sync.
  // failedNonce null = a dropped trade (never mined): like the one-at-a-time
  // mode, trust the chain's count.
  private pauseAndResync(why: string, failedNonce: number | null): Promise<void> {
    if (!this.live) return Promise.resolve();
    if (this.pause) return this.pause;
    this.pause = (async () => {
      // Wait for every send still on its way (their outcomes are recorded as they land).
      while (this.sending.size) await Promise.allSettled([...this.sending]);
      const remote = await this.readProvider.getTransactionCount(this.wallet.address, 'pending').catch(() => null);
      const before = this.nonce!;
      let next: number;
      if (failedNonce === null) {
        // A sent trade was never mined: its nonce is free again.
        next = remote ?? before;
        this.maxAccepted = Math.min(this.maxAccepted, next - 1);
        this.usedFloor = Math.min(this.usedFloor, next);
        this.acceptedNonces.clear();
      } else {
        // Lowest failed nonce that nothing says is used: re-sign at it (no hole).
        const lowestFailed = this.failedNonces.size ? Math.min(...this.failedNonces) : null;
        const usedBelow = Math.max(remote ?? -1, this.usedFloor);
        if (lowestFailed !== null && lowestFailed >= usedBelow && !this.acceptedNonces.has(lowestFailed)) next = lowestFailed;
        else next = Math.max(remote ?? -1, this.maxAccepted + 1, this.usedFloor);
      }
      this.failedNonces.clear();
      for (const a of this.acceptedNonces) if (a < next) this.acceptedNonces.delete(a);
      this.nonce = next;
      this.log(`[fire] nonce re-sync (${why}): next nonce ${next} (was ${before}; chain says ${remote ?? 'unreadable'}, highest accepted ${this.maxAccepted})`);
    })().finally(() => { this.pause = null; });
    return this.pause;
  }

  // For tests / status: is a nonce re-sync running right now?
  get resyncing(): boolean { return this.pause !== null; }
}
