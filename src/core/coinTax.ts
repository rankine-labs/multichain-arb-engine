import * as fs from 'fs';
import type { Rpc } from '../execution/simulator';

// ============================================================================
// COIN TAX TEST (Oct 20, owner approved). PRACTICE ONLY, NEVER SENDS.
//
// Plain English:
//   Some coins take a cut every time they move (a "transfer tax"). The loop
//   maths assumes a coin arrives in full, so a loop through a taxed coin
//   looks like it makes money but really loses. On Oct 20 the coin the bot
//   called "MCD" (0x378a50...5c14, real name "Meridian Capital", not
//   McDonald's) took 3.0% on every move, and it was in 90% of the 23,602
//   loop checks that lost.
//
//   Before a coin can be used in a loop, this file tests it ONCE with a free
//   simulation on the real chain (eth_simulateV1, nothing is sent):
//     1. move 0.1% of what a pool holds of the coin from the pool to a test
//        address (like a "buy"): did the full amount arrive?
//     2. move 90% of that back into the pool (like a "sell"): did the pool
//        receive the full amount?
//   If either move loses more than 0.05%, the coin is "taxed". If a move is
//   refused, the coin is "blocked". Either way it is left out of loops.
//   A coin that passed is tested again after 6 hours (a tax can be switched
//   on later); a taxed or blocked coin after 24 hours.
//
//   Results are saved to data/coin-tax.json so a restart doesn't re-test.
//   Coins on the loop pools are tested ahead of time (LOOP_TAX_TESTS_PER_MIN,
//   default 10 a minute), so most are known before a loop through them pays.
//   LOOP_TAX_TEST=0 turns all of this off (loops behave exactly as before).
// ============================================================================

export type TaxVerdict = 'ok' | 'taxed' | 'blocked';
// verdict null = the test couldn't tell (node busy, no simulation support,
// pool holds none of the coin): nothing is recorded, it is tried again later.
export interface TaxTestResult { verdict: TaxVerdict | null; lossPct?: number; why?: string }
export type TaxTester = (token: string, holder: string) => Promise<TaxTestResult>;

interface TaxRec { v: TaxVerdict; at: number; lossPct?: number }

export interface CoinTaxConfig {
  enabled: boolean;      // LOOP_TAX_TEST (default on)
  perMin: number;        // LOOP_TAX_TESTS_PER_MIN (default 6)
  okRecheckMs: number;   // a passed coin is tested again after this (6 h)
  badRecheckMs: number;  // a taxed / blocked coin is tested again after this (24 h)
  retryMs: number;       // after "couldn't tell", wait this long before trying again (10 min)
}

const num = (raw: string | undefined, dflt: number, min: number, max: number): number => {
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
};

export function coinTaxConfigFromEnv(env: Record<string, string | undefined> = process.env): CoinTaxConfig {
  const raw = (env.LOOP_TAX_TEST ?? '').trim().toLowerCase();
  return {
    enabled: !(raw === '0' || raw === 'false' || raw === 'off'),
    perMin: Math.round(num(env.LOOP_TAX_TESTS_PER_MIN, 10, 1, 60)),
    okRecheckMs: 6 * 3600_000,
    badRecheckMs: 24 * 3600_000,
    retryMs: 10 * 60_000,
  };
}

// The address coins are moved to in the test. Any normal address works; this
// one holds nothing and is not a precompile or a pool.
export const TAX_TEST_ADDRESS = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';

// A move that loses more than this share counts as a tax (0.05%). Plain
// rounding loses at most 1 unit of the coin, far below this.
const TAX_TOLERANCE_BPS = 5n;

const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const hex = (n: bigint) => n.toString(16).padStart(64, '0');
const balanceOfData = (who: string) => '0x70a08231' + pad(who);
const transferData = (to: string, amt: bigint) => '0xa9059cbb' + pad(to) + hex(amt);
const toBig = (h: unknown): bigint | null => (typeof h === 'string' && /^0x[0-9a-f]+$/i.test(h) ? BigInt(h) : null);

// True when `got` is short of `sent` by more than the tolerance.
export function lostMoreThanTolerance(sent: bigint, got: bigint): boolean {
  if (sent <= 0n) return false;
  return got * 10_000n < sent * (10_000n - TAX_TOLERANCE_BPS);
}

// One tax test on the real chain (two node requests: a balance read and one
// simulation). Never sends anything. `holder` = the address holding the
// pool's coins (the pool itself, or the V4 PoolManager for V4 pools).
export async function testCoinTax(rpc: Rpc, token: string, holder: string, testAddr = TAX_TEST_ADDRESS): Promise<TaxTestResult> {
  const b = await rpc('eth_call', [{ to: token, data: balanceOfData(holder) }, 'latest']);
  if (b.error) return { verdict: null, why: `balance read: ${b.error.message ?? 'error'}`.slice(0, 120) };
  const bal = toBig(b.result);
  if (bal === null || bal === 0n) return { verdict: null, why: 'pool holds none of the coin' };
  const amt = bal / 1000n > 0n ? bal / 1000n : 1n;
  const back = (amt * 9n) / 10n;
  const calls = [
    { to: token, data: balanceOfData(testAddr) },                    // 0: test address before
    { from: holder, to: token, data: transferData(testAddr, amt) },  // 1: pool -> test address ("buy")
    { to: token, data: balanceOfData(testAddr) },                    // 2: test address after
    { to: token, data: balanceOfData(holder) },                      // 3: pool before the move back
    { from: testAddr, to: token, data: transferData(holder, back) }, // 4: test address -> pool ("sell")
    { to: token, data: balanceOfData(holder) },                      // 5: pool after
  ];
  const s = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls }] }, 'latest']);
  if (s.error) return { verdict: null, why: `simulation: ${s.error.message ?? 'error'}`.slice(0, 120) };
  const res: any[] | undefined = s.result?.[0]?.calls;
  if (!Array.isArray(res) || res.length !== calls.length) return { verdict: null, why: 'simulation: unexpected answer' };
  const okCall = (i: number) => res[i]?.status === '0x1' || res[i]?.status === 1 || res[i]?.status === true;
  if (!okCall(1)) return { verdict: 'blocked', why: `move out of the pool refused${res[1]?.error?.message ? ` (${String(res[1].error.message).slice(0, 60)})` : ''}` };
  const b0 = toBig(res[0]?.returnData), b1 = toBig(res[2]?.returnData);
  if (b0 === null || b1 === null) return { verdict: null, why: 'simulation: balance not readable' };
  const got = b1 - b0;
  // A tax over 10% means the move back (90%) can't be paid: blocked for loops anyway.
  if (!okCall(4)) {
    const pct = amt > 0n ? Number(((amt - got) * 10_000n) / amt) / 100 : 0;
    return got < back ? { verdict: 'taxed', lossPct: pct, why: 'over 10% taken on the move out' }
      : { verdict: 'blocked', why: 'move back into the pool refused' };
  }
  const h0 = toBig(res[3]?.returnData), h1 = toBig(res[5]?.returnData);
  if (h0 === null || h1 === null) return { verdict: null, why: 'simulation: balance not readable' };
  const gotBack = h1 - h0;
  const lossOut = amt > 0n && got < amt ? Number(((amt - got) * 10_000n) / amt) / 100 : 0;
  const lossBack = back > 0n && gotBack < back ? Number(((back - gotBack) * 10_000n) / back) / 100 : 0;
  if (lostMoreThanTolerance(amt, got) || lostMoreThanTolerance(back, gotBack)) {
    return { verdict: 'taxed', lossPct: Math.max(lossOut, lossBack), why: `out ${lossOut}%, back ${lossBack}%` };
  }
  return { verdict: 'ok' };
}

// What the loop trader asks (core/loopTrader.ts). Tests use a fake one.
export interface CoinTaxGate {
  // 'ok' / 'taxed' / 'blocked', or undefined = not tested yet (or the result expired).
  verdict(token: string): TaxVerdict | undefined;
  // Ask for a test of this coin (holder = who holds the pool's coins). Repeats are ignored.
  request(token: string, holder: string): void;
  // A test is waiting and the per-minute limit has room.
  hasWork(): boolean;
  // Run the next waiting test now, if any and within the per-minute limit.
  // Resolves false when nothing was run.
  runNext(): Promise<boolean>;
  // Report numbers (cumulative since start).
  stats(): CoinTaxStats;
}
export interface CoinTaxStats { tested: number; ok: number; taxed: number; blocked: number; waiting: number; unclear: number; taxedNames: string[]; topUnclear?: [string, number] | null }

export class CoinTaxBook implements CoinTaxGate {
  private recs = new Map<string, TaxRec>();
  private queue: { token: string; holder: string }[] = [];
  private queued = new Set<string>();
  private retryAt = new Map<string, number>();
  private times: number[] = [];
  private unclear = 0;
  private unclearWhy = new Map<string, number>();
  private lastUnclearLog = 0;
  private dirty = false;
  private lastSave = 0;

  constructor(
    private readonly cfg: CoinTaxConfig,
    private readonly tester: TaxTester,
    private readonly o: {
      now?: () => number;
      file?: string | null;
      log?: (m: string) => void;
      symbolOf?: (t: string) => string;
      alwaysOk?: string[];       // coins never tested (WETH, USDG)
    } = {},
  ) {
    for (const t of o.alwaysOk ?? []) this.recs.set(t.toLowerCase(), { v: 'ok', at: Number.MAX_SAFE_INTEGER / 2 });
    this.load();
  }

  private now(): number { return (this.o.now ?? Date.now)(); }
  private sym(t: string): string { return this.o.symbolOf ? this.o.symbolOf(t) : `${t.slice(0, 6)}...${t.slice(-4)}`; }

  verdict(token: string): TaxVerdict | undefined {
    const r = this.recs.get(token.toLowerCase());
    if (!r) return undefined;
    const age = this.now() - r.at;
    // Expired results: a passed coin after 6 h, a bad one after 24 h. A bad
    // coin stays bad until its re-test says otherwise (never "unknown").
    if (r.v === 'ok' && age > this.cfg.okRecheckMs) return undefined;
    return r.v;
  }

  // A bad coin whose result is older than 24 h is queued for a re-test by
  // request() (the loop trader keeps it out of loops until then).
  private due(token: string): boolean {
    const r = this.recs.get(token);
    if (!r) return true;
    const age = this.now() - r.at;
    return r.v === 'ok' ? age > this.cfg.okRecheckMs : age > this.cfg.badRecheckMs;
  }

  request(token: string, holder: string): void {
    const t = token.toLowerCase();
    if (this.queued.has(t) || !this.due(t)) return;
    if ((this.retryAt.get(t) ?? 0) > this.now()) return;
    if (this.queue.length >= 200) return; // bounded: the rest are asked for again later
    this.queued.add(t);
    this.queue.push({ token: t, holder });
  }

  hasWork(): boolean {
    if (!this.queue.length) return false;
    const t = this.now();
    while (this.times.length && t - this.times[0] > 60_000) this.times.shift();
    return this.times.length < this.cfg.perMin;
  }

  async runNext(): Promise<boolean> {
    if (!this.hasWork()) return false;
    const job = this.queue.shift()!;
    this.queued.delete(job.token);
    this.times.push(this.now());
    let r: TaxTestResult;
    try { r = await this.tester(job.token, job.holder); }
    catch (e) { r = { verdict: null, why: (e as Error).message }; }
    if (r.verdict === null) {
      this.unclear++;
      // Why it couldn't tell (shown in the hour line, logged at most once a minute).
      const why = (r.why ?? 'unknown').replace(/0x[0-9a-fA-F]{8,}/g, '0x..').slice(0, 60);
      this.unclearWhy.set(why, (this.unclearWhy.get(why) ?? 0) + 1);
      if (this.unclearWhy.size > 20) this.unclearWhy.clear();
      if (this.now() - this.lastUnclearLog > 60_000) {
        this.lastUnclearLog = this.now();
        this.o.log?.(`[loop] coin test for ${this.sym(job.token)} couldn't tell (${why}): tried again later`);
      }
      // A busy node is a passing problem: try again in 1 minute, not 10.
      const busy = /busy|too long|slow down|429|rate/i.test(why);
      this.retryAt.set(job.token, this.now() + (busy ? 60_000 : this.cfg.retryMs));
      if (this.retryAt.size > 5_000) this.retryAt.clear();
      return true;
    }
    const before = this.recs.get(job.token)?.v;
    this.recs.set(job.token, { v: r.verdict, at: this.now(), ...(r.lossPct !== undefined ? { lossPct: r.lossPct } : {}) });
    if (r.verdict !== 'ok' && before !== r.verdict) {
      this.o.log?.(`[loop] coin ${this.sym(job.token)} (${job.token}) ${r.verdict === 'taxed' ? `takes a cut when moved${r.lossPct !== undefined ? ` (${r.lossPct}%)` : ''}` : 'cannot be moved freely'}: left out of loops${r.why ? ` [${r.why}]` : ''}`);
    } else if (r.verdict === 'ok' && before && before !== 'ok') {
      this.o.log?.(`[loop] coin ${this.sym(job.token)} (${job.token}) passed its re-test: allowed in loops again`);
    }
    this.dirty = true;
    this.save();
    return true;
  }

  stats(): CoinTaxStats {
    let ok = 0, taxed = 0, blocked = 0;
    const names: string[] = [];
    for (const [t, r] of this.recs) {
      if (r.at > this.now() + 1e12) continue; // the always-ok base coins
      if (r.v === 'ok') ok++;
      else { if (r.v === 'taxed') taxed++; else blocked++; if (names.length < 8) names.push(this.sym(t)); }
    }
    const top = [...this.unclearWhy.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    return { tested: ok + taxed + blocked, ok, taxed, blocked, waiting: this.queue.length, unclear: this.unclear, taxedNames: names, topUnclear: top };
  }

  // ---- saved results (data/coin-tax.json) ----
  private load(): void {
    const f = this.o.file;
    if (!f) return;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [t, r] of Object.entries<any>(j?.coins ?? {})) {
        if ((r?.v === 'ok' || r?.v === 'taxed' || r?.v === 'blocked') && Number.isFinite(r?.at)) {
          this.recs.set(t.toLowerCase(), { v: r.v, at: r.at, ...(Number.isFinite(r.lossPct) ? { lossPct: r.lossPct } : {}) });
        }
      }
    } catch { /* no file yet or unreadable: start empty */ }
  }

  // At most once a minute, written to a temp file then renamed (never half written).
  save(force = false): void {
    const f = this.o.file;
    if (!f || !this.dirty) return;
    const t = this.now();
    if (!force && t - this.lastSave < 60_000) return;
    const coins: Record<string, TaxRec> = {};
    for (const [k, r] of this.recs) if (r.at < t + 1e12) coins[k] = r;
    try {
      const tmp = `${f}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: t, coins }));
      fs.renameSync(tmp, f);
      this.dirty = false;
      this.lastSave = t;
    } catch { /* best effort: results are kept in memory either way */ }
  }
}

// Who holds a pool's coins: the pool itself, or the V4 PoolManager for V4
// pools (their poolAddress is the 32-byte pool id, not an address).
export function coinHolderOf(p: { poolAddress: string; v4?: { poolManager: string } | null }): string | null {
  if (p.v4?.poolManager) return p.v4.poolManager;
  return /^0x[0-9a-fA-F]{40}$/.test(p.poolAddress) ? p.poolAddress : null;
}
