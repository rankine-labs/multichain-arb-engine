import type { ExecutorHop } from './executorCalldata';
import { encodeExecuteRaw, encodeExecuteV3FlashRaw, usdToTokenUnits } from './executorCalldata';
import type { SimResult } from './simulator';
import { decideCheckFirst } from '../core/checkFirst';
import { loopGasUnits } from '../core/loopTrader';

// ============================================================================
// LIVE LOOPS (Oct 20, owner approved). REAL MONEY when the bot is live.
//
// Plain English:
//   The loop finder (core/loopFinder.ts, in the loop worker thread) spots
//   loops like WETH -> USDG -> PONS -> WETH that look like they pay. Until now
//   it could only PRACTICE them. With LOOP_LIVE=1 a loop that passes every
//   filter in the worker (coins vetted, coins passed the tax test, route not
//   benched, at most LOOP_LIVE_MAX_POOLS pools) is handed to this file, in the
//   main thread, which does the same steps as a live 2-pool trade:
//
//     1. limits: one loop at a time, at most LOOP_LIVE_MAX_PER_HOUR sends and
//        LOOP_LIVE_CHECKS_PER_HOUR real checks an hour, not paused by the
//        loop loss cap, this exact loop not failing over and over
//     2. the exchanges and coins must be cleared for live trading
//     3. how it's paid for: the contract's own money if it really holds the
//        whole amount; otherwise a flash loan from an approved lender that is
//        not one of the loop's own pools (the contract refuses that anyway)
//     4. CHECK FIRST: if a trade opened the loop, wait until it is in a block;
//        then run the real check of our exact loop (same funding) on the paid
//        checking node. Sent only if it makes money after gas and clears the
//        normal send minimum, on the smaller of the guess and the check
//     5. too-good-to-be-true profits (outlier guard) are not sent
//     6. the normal safety gate (daily loss cap, pending trades, allowlist)
//     7. build the contract call (deadline = a few blocks from now, profit
//        floor = what the check found) and send it through the same sender
//   The contract's own profit check still protects every send: if the profit
//   is gone by the time it lands, the trade reverts and only gas is lost.
//
//   LOOP LOSS CAP: gas lost on failed LIVE loop trades is added up per
//   Toronto day. At LOOP_LIVE_LOSS_CAP_USD ($2) live loops pause until the
//   next day (2-pool trading is not affected) and a Telegram alert goes out.
//
//   LOOP_LIVE=0 (or unset) = off: loops stay practice only, exactly as before.
// ============================================================================

export interface LoopLiveConfig {
  enabled: boolean;          // LOOP_LIVE=1
  maxPools: number;          // LOOP_LIVE_MAX_POOLS (default 3)
  maxPerHour: number;        // LOOP_LIVE_MAX_PER_HOUR sends (default 20)
  checksPerHour: number;     // LOOP_LIVE_CHECKS_PER_HOUR real checks on the paid node (default 120)
  lossCapUsd: number;        // LOOP_LIVE_LOSS_CAP_USD gas lost on failed loops per day (default 2)
  maxTradeUsd: number;       // LOOP_LIVE_MAX_TRADE_USD biggest loop (default 10,000)
  failsToBlock: number;      // this loop failing its real check this many times in a row ...
  blockMs: number;           // ... is not checked again for this long (3 in a row, 30 min)
  maxAgeMs: number;          // a loop found longer ago than this is skipped (2 s)
}

const num = (raw: string | undefined, dflt: number, min: number, max: number): number => {
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
};

export function loopLiveConfigFromEnv(env: Record<string, string | undefined> = process.env): LoopLiveConfig {
  const on = (env.LOOP_LIVE ?? '').trim().toLowerCase();
  return {
    enabled: on === '1' || on === 'true' || on === 'on',
    maxPools: Math.round(num(env.LOOP_LIVE_MAX_POOLS, 3, 3, 5)),
    maxPerHour: Math.round(num(env.LOOP_LIVE_MAX_PER_HOUR, 20, 0, 1_000)),
    checksPerHour: Math.round(num(env.LOOP_LIVE_CHECKS_PER_HOUR, 120, 0, 10_000)),
    lossCapUsd: num(env.LOOP_LIVE_LOSS_CAP_USD, 2, 0, 1_000),
    maxTradeUsd: num(env.LOOP_LIVE_MAX_TRADE_USD, 10_000, 1, 1e6),
    failsToBlock: 3,
    blockMs: 30 * 60_000,
    maxAgeMs: 2_000,
  };
}

// One loop handed over by the loop worker (plain data: it crosses threads).
export interface LoopLiveCandidate {
  sig: string;               // the loop's identity (base + pools in order)
  label: string;             // coin names, e.g. "WETH/USDG/PONS/WETH"
  base: string;              // the coin it starts and ends with (WETH or USDG)
  amountIn: bigint;          // best size, base-coin units
  sizeUsd: number;
  netUsd: number;            // the finder's guess, after gas
  poolKeys: string[];        // pool addresses / V4 pool ids, in order
  hops: ExecutorHop[];       // the contract's hop list (built in the worker)
  coins: string[];           // every coin on the loop (lower case)
  triggerHash?: string;      // the feed trade that opened the loop, if any
  foundAt: number;           // ms
}

export type LoopFunding = { kind: 'own' } | { kind: 'flash'; lender: string; feePips: number };

// What the rest of the bot provides (shadowMain wires these; tests fake them).
export interface LoopLiveDeps {
  now: () => number;
  live: () => boolean;                                   // the bot is really live (sending real trades)
  // 2: exchanges + coins cleared for live trading (null = ok, else the reason)
  liveBlocker: (c: LoopLiveCandidate) => string | null;
  // 3: how to pay (null = can't: no money and no usable lender)
  funding: (c: LoopLiveCandidate) => LoopFunding | null;
  // 4: wait for the trade that opened the loop to land (true = in a block)
  waitForTrade: (hash: string) => Promise<boolean>;
  // 4: the real check of our exact loop on the paid checking node
  check: (c: LoopLiveCandidate, lender: string | undefined) => Promise<SimResult>;
  gasUsd: (pools: number, flash: boolean) => number;    // our gas for this loop
  minNetUsd: () => number;                               // the normal send minimum
  usdOf: (token: string) => number | null;
  decimalsOf: (token: string) => number | undefined;
  isOutlier: (netUsd: number, sizeUsd: number) => boolean;
  // 6: the normal safety gate (null = ok, else the reason)
  safety: (sizeUsd: number, coins: string[]) => string | null;
  // 7: send. deadline() null = block info stale (don't send).
  deadline: () => bigint | null;
  ready: () => string | null;                            // live readiness checks (null = passed)
  gasLimitOk: (gasUnits: number) => boolean;             // the sender's gas limit covers this loop
  executor: () => string | undefined;
  fire: (to: string, data: string) => Promise<{ live: boolean; txHash?: string; error?: string; signMs?: number }>;
  // After a real send: the same bookkeeping as 2-pool trades (trade file, tracker, pending gas).
  afterSent: (hash: string, info: { label: string; sizeUsd: number; netUsd: number; funding: LoopFunding; kinds: number[]; poolKeys: string[]; gasUsd: number }) => void;
  log: (m: string) => void;
  alert: (html: string) => void;
  dayOf?: (ms: number) => string;                        // Toronto day (loss cap)
}

export interface LoopLiveHour {
  offered: number; checked: number; passed: number; sent: number; dryRun: number;
  won: number; wonUsd: number; failed: number; gasLostUsd: number;
  skipped: Map<string, number>;   // reason -> count
}
const emptyHour = (): LoopLiveHour => ({ offered: 0, checked: 0, passed: 0, sent: 0, dryRun: 0, won: 0, wonUsd: 0, failed: 0, gasLostUsd: 0, skipped: new Map() });

const torontoDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

export class LoopLiveSender {
  private busy = false;
  private sends: number[] = [];
  private checks: number[] = [];
  private fails = new Map<string, { n: number; until: number }>();
  private day: string;
  private lossToday = 0;
  private pausedDay: string | null = null;
  private hour = emptyHour();
  // Our live loop trades not settled yet: hash -> loop, its pools, and the gas it could lose.
  // A loop (or any loop sharing a pool) is not sent again while one is in flight,
  // and their gas counts toward the loop loss cap until they settle.
  private sentHashes = new Map<string, { sig: string; pools: string[]; holdUsd: number; at: number }>();

  constructor(readonly cfg: LoopLiveConfig, private d: LoopLiveDeps) {
    this.day = this.dayOf(d.now());
  }

  private dayOf(ms: number): string { return (this.d.dayOf ?? torontoDay)(ms); }
  private skip(why: string): void { this.hour.skipped.set(why, (this.hour.skipped.get(why) ?? 0) + 1); if (this.hour.skipped.size > 40) this.hour.skipped.clear(); }
  private rollDay(): void { const d = this.dayOf(this.d.now()); if (d !== this.day) { this.day = d; this.lossToday = 0; } }
  pausedToday(): boolean { this.rollDay(); return this.pausedDay === this.day; }
  isLoopTrade(hash: string): boolean { return this.sentHashes.has(hash.toLowerCase()); }
  // In-flight entries older than 10 min are dropped (the tracker reports every
  // trade well before that; this only guards against a lost result).
  private inflight(): { pools: Set<string>; sigs: Set<string>; holdUsd: number } {
    const t = this.d.now(), pools = new Set<string>(), sigs = new Set<string>();
    let hold = 0;
    for (const [h, e] of this.sentHashes) {
      if (t - e.at > 10 * 60_000) { this.sentHashes.delete(h); continue; }
      sigs.add(e.sig); for (const p of e.pools) pools.add(p); hold += e.holdUsd;
    }
    return { pools, sigs, holdUsd: hold };
  }

  // A loop from the worker. Never throws; one at a time.
  async offer(c: LoopLiveCandidate): Promise<void> {
    if (!this.cfg.enabled) return;
    this.hour.offered++;
    if (this.busy) { this.skip('another loop is being checked'); return; }
    this.busy = true;
    try { await this.tryOne(c); }
    catch (e) { this.d.log(`[loop-live] ${c.label} skipped (error: ${(e as Error).message})`); this.skip('error'); }
    finally { this.busy = false; }
  }

  private async tryOne(c: LoopLiveCandidate): Promise<void> {
    const now = this.d.now();
    if (this.pausedToday()) { this.skip('loop loss cap reached today'); return; }
    if (now - c.foundAt > this.cfg.maxAgeMs) { this.skip('found too long ago'); return; }
    if (c.hops.length > this.cfg.maxPools) { this.skip(`more than ${this.cfg.maxPools} pools`); return; }
    if (c.sizeUsd > this.cfg.maxTradeUsd) { this.skip('over the loop size limit'); return; }
    if (c.hops[0]?.tokenIn.toLowerCase() !== c.base.toLowerCase() || c.hops[c.hops.length - 1]?.tokenOut.toLowerCase() !== c.base.toLowerCase()) { this.skip('route does not start and end in the base coin'); return; }
    const f = this.fails.get(c.sig);
    if (f && f.until > now) { this.skip('this loop failed its last real checks'); return; }
    const fl = this.inflight();
    if (fl.sigs.has(c.sig) || c.poolKeys.some((k) => fl.pools.has(k.toLowerCase()))) { this.skip('a loop on these pools is still in flight'); return; }
    while (this.sends.length && now - this.sends[0] > 3600_000) this.sends.shift();
    while (this.checks.length && now - this.checks[0] > 3600_000) this.checks.shift();
    if (this.sends.length >= this.cfg.maxPerHour) { this.skip('hourly send limit'); return; }
    if (this.checks.length >= this.cfg.checksPerHour) { this.skip('hourly check limit'); return; }
    const blocked = this.d.liveBlocker(c);
    if (blocked) { this.skip(`not cleared for live: ${blocked}`.slice(0, 80)); return; }
    const funding = this.d.funding(c);
    if (!funding) { this.skip('no own money and no usable lender'); return; }
    const flash = funding.kind === 'flash';
    if (!this.d.gasLimitOk(loopGasUnits(c.hops.length) + (flash ? 100_000 : 0))) { this.skip('sender gas limit too low for this loop'); return; }
    // Loss cap with the trades still in flight counted as if they failed.
    const gasUsd = this.d.gasUsd(c.hops.length, flash);
    if (this.lossTodayUsd() + fl.holdUsd + gasUsd > this.cfg.lossCapUsd) { this.skip('loop loss cap (counting trades in flight)'); return; }
    await this.checkAndSend(c, funding);
  }

  private async checkAndSend(c: LoopLiveCandidate, funding: LoopFunding): Promise<void> {
    const t0 = this.d.now();
    const flash = funding.kind === 'flash';
    const lender = funding.kind === 'flash' ? funding.lender : undefined;
    if (c.triggerHash) {
      const landed = await this.d.waitForTrade(c.triggerHash);
      if (!landed) { this.skip('followed trade not in a block in time'); return; }
    }
    this.checks.push(this.d.now());
    this.hour.checked++;
    const r = await this.d.check(c, lender);
    const gasUsd = this.d.gasUsd(c.hops.length, flash);
    // The check measured the gas our loop really uses (replays report it): it must fit the limit too.
    const used = (r.status === 'profit' || r.status === 'loss') && r.gasUsed ? Number(r.gasUsed) : 0;
    if (used > 0 && !this.d.gasLimitOk(used)) { this.skip('sender gas limit too low for this loop (measured)'); return; }
    // The check reports profit in base-coin units; decideCheckFirst wants USD.
    const dec = this.d.decimalsOf(c.base), usd = this.d.usdOf(c.base);
    const answer = r.status === 'profit'
      ? (dec === undefined || !usd ? { status: 'skipped' as const, reason: 'unknown price or decimals' } : { status: 'profit' as const, usd: (Number(r.profit) / 10 ** dec) * usd })
      : r.status === 'loss' ? { status: 'loss' as const, reason: 'loss' }
        : r.status === 'rate_limited' ? { status: 'rate_limited' as const }
          : { status: r.status === 'fail' ? 'fail' as const : 'skipped' as const, reason: 'reason' in r ? r.reason : 'unknown' };
    const v = decideCheckFirst(answer, gasUsd, this.d.minNetUsd(), c.netUsd);
    const ms = this.d.now() - t0;
    const pay = flash ? `flash loan ${(funding as { feePips: number }).feePips / 10_000}%` : 'own money';
    if (!v.send) {
      if (v.blockPair) this.noteFail(c);
      this.d.log(`[loop-live] NOT SENT ${c.label}: guess $${c.netUsd.toFixed(2)} on $${Math.round(c.sizeUsd)} (${pay}), ${v.why} (${ms} ms)`);
      this.skip(`real check: ${v.why.replace(/\$[\d.]+/g, '$N')}`.slice(0, 80));
      return;
    }
    this.fails.delete(c.sig);
    this.hour.passed++;
    // The guard looks at the bigger of the guess and the check (same as 2-pool trades),
    // so a check that says $200 can't slip past just because the guess said $1.
    const checkNet = answer.status === 'profit' ? answer.usd - gasUsd : v.netUsd;
    if (this.d.isOutlier(Math.max(v.netUsd, checkNet), c.sizeUsd)) { this.d.log(`[loop-live] NOT SENT ${c.label}: $${v.netUsd.toFixed(2)} on $${Math.round(c.sizeUsd)} is too good to be true (outlier guard)`); this.skip('outlier profit (too good to be true)'); return; }
    const unsafe = this.d.safety(c.sizeUsd, c.coins);
    if (unsafe) { this.skip(`safety gate: ${unsafe}`.replace(/\$\d+(\.\d+)?/g, '$N').slice(0, 80)); return; }
    const live = this.d.live(); // read once for this send
    const notReady = live ? this.d.ready() : null;
    if (notReady) { this.skip(notReady); return; }
    const deadline = live ? this.d.deadline() : 0n;
    if (deadline === null) { this.skip('block info stale'); return; }
    if (dec === undefined || !usd) { this.skip('unknown price or decimals'); return; }
    const minProfit = usdToTokenUnits(v.netUsd, usd, dec);
    if (minProfit <= 0n) { this.skip('profit floor rounds to zero'); return; }
    const to = this.d.executor();
    if (live && !to) { this.skip('no trade contract set'); return; }
    const trade = { token: c.hops[0].tokenIn, amountIn: c.amountIn, minProfit, maxBlock: deadline, hops: c.hops };
    const data = lender ? encodeExecuteV3FlashRaw(trade, lender) : encodeExecuteRaw(trade);
    const fired = await this.d.fire(to ?? '0x0000000000000000000000000000000000000000', data);
    if (!fired.live || !live) {
      this.hour.dryRun++;
      this.d.log(`[loop-live] DRY RUN (bot not live) ${c.label}: would send for $${v.netUsd.toFixed(2)} after gas on $${Math.round(c.sizeUsd)} (${pay}), checked in ${ms} ms`);
      return;
    }
    if (!fired.txHash) {
      this.d.log(`[loop-live] SEND FAILED ${c.label}: ${fired.error ?? 'no hash'}`);
      this.skip('node refused the send');
      return;
    }
    this.sends.push(this.d.now());
    this.hour.sent++;
    this.sentHashes.set(fired.txHash.toLowerCase(), { sig: c.sig, pools: c.poolKeys.map((k) => k.toLowerCase()), holdUsd: gasUsd, at: this.d.now() });
    if (this.sentHashes.size > 500) this.sentHashes.delete(this.sentHashes.keys().next().value as string);
    this.d.log(`[loop-live] SENT ${c.label}: $${v.netUsd.toFixed(2)} after gas on $${Math.round(c.sizeUsd)} (${pay}), checked in ${ms} ms, tx ${fired.txHash}`);
    this.d.afterSent(fired.txHash, { label: `loop ${c.label}`, sizeUsd: c.sizeUsd, netUsd: v.netUsd, funding, kinds: c.hops.map((h) => h.kind), poolKeys: c.poolKeys, gasUsd });
  }

  private noteFail(c: LoopLiveCandidate): void {
    const f = this.fails.get(c.sig) ?? { n: 0, until: 0 };
    f.n++;
    if (f.n >= this.cfg.failsToBlock) { f.n = 0; f.until = this.d.now() + this.cfg.blockMs; }
    this.fails.set(c.sig, f);
    if (this.fails.size > 2_000) { const t = this.d.now(); for (const [k, v] of this.fails) if (v.until <= t && v.n === 0) this.fails.delete(k); }
  }

  // The final result of one of OUR live loop trades (from the live tracker).
  noteResult(r: { hash: string; status: 'profit' | 'reverted' | 'dropped'; gasUsd: number; profitUsd?: number; label: string }): void {
    const e = this.sentHashes.get(r.hash.toLowerCase());
    if (e === undefined) return;
    const sig = e.sig;
    this.sentHashes.delete(r.hash.toLowerCase());
    this.rollDay();
    if (r.status === 'profit') { this.hour.won++; this.hour.wonUsd += r.profitUsd ?? 0; return; }
    this.hour.failed++;
    const gas = Number.isFinite(r.gasUsd) ? r.gasUsd : 0;
    this.hour.gasLostUsd += gas;
    this.lossToday += gas;
    // A loop that failed on the chain is not tried again for a while.
    this.fails.set(sig, { n: 0, until: this.d.now() + this.cfg.blockMs });
    if (this.lossToday >= this.cfg.lossCapUsd && this.pausedDay !== this.day) {
      this.pausedDay = this.day;
      const msg = `Live loops PAUSED until tomorrow: $${this.lossToday.toFixed(2)} of gas lost on failed loop trades today (limit $${this.cfg.lossCapUsd.toFixed(2)}). Regular trades keep running.`;
      this.d.log(`[loop-live] ${msg}`);
      this.d.alert(`⏸️ <b>LIVE LOOPS PAUSED</b>\n${msg}`);
    }
  }

  lossTodayUsd(): number { this.rollDay(); return this.lossToday; }

  // One plain line for the log / status page / hourly report; starts a new hour if take.
  hourLine(take = true): string {
    const h = this.hour;
    if (take) this.hour = emptyHour();
    const top = [...h.skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ${n}`).join('; ');
    const paused = this.pausedToday() ? ', PAUSED (loss cap)' : '';
    return `[loop-live] hour: offered ${h.offered}, real checks ${h.checked}, passed ${h.passed}, sent ${h.sent}${h.dryRun ? `, dry run ${h.dryRun}` : ''}, won ${h.won} ($${h.wonUsd.toFixed(2)}), failed ${h.failed} (gas $${h.gasLostUsd.toFixed(2)}), loop gas lost today $${this.lossTodayUsd().toFixed(2)}/$${this.cfg.lossCapUsd.toFixed(2)}${paused}${top ? ` | not sent: ${top}` : ''}`;
  }
}
