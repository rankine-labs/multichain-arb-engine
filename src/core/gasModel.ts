import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { loopGasUsd, loopGasUnits } from './loopTrader';

// ============================================================================
// GAS MODEL -- what one trade's gas costs, from measured numbers (Oct 13)
//
// Plain English:
//   Every trade idea has gas taken off its profit before the bot decides.
//   Before this, Robinhood used ONE number for every kind of trade: the
//   current gas price x 450,000 gas (or the most a real trade ever used) +
//   the cost of posting ~1 KB to the parent chain, with no safety margin,
//   and a flat 5 cents whenever that wasn't known yet. It also never noticed
//   when the gas price reading had gone old.
//
//   Now (GAS_FROM_LIVE, on by default):
//     gas USD = (gas units for THIS kind of trade + parent-chain posting gas)
//               x current gas price x ETH price x GAS_MARGIN (default 1.3)
//   kept between GAS_MIN_USD (default 1 cent) and, as a warning only,
//   GAS_MAX_USD (default 50 cents: above it the value is still used, never
//   lowered, but counted as "suspiciously high" so a bad reading shows up).
//
//   "Gas units for this kind of trade":
//     - the median of what our own trades really used, once there are at
//       least GAS_MIN_SAMPLES (default 10) of that kind. Samples come from
//       live receipts (wins, and reverts that ran most of the route) and
//       from practice checks that report gas (the "right after trigger"
//       replays). Kept per kind: 2-pool trades by exchange mix and funding
//       (own money / loan), loops by number of pools. Saved to
//       data/gas-calibration.json so restarts keep them.
//     - before that: the fork-measured defaults (335k own money, 477k with
//       a loan; loops 123k + 128k per pool).
//
//   Falls back to the old flat $0.05 when the gas price reading is missing
//   or older than GAS_MAX_AGE_MS (default 30 s), or the ETH price is unknown.
//   GAS_FROM_LIVE=0 = exactly the old behaviour.
//
//   Read only: this file never sends anything and never touches keys.
// ============================================================================

export interface GasSettings {
  fromLive: boolean;     // GAS_FROM_LIVE (default on)
  margin: number;        // GAS_MARGIN (default 1.3 = +30%)
  minUsd: number;        // GAS_MIN_USD (default 0.01)
  maxUsd: number;        // GAS_MAX_USD (default 0.50): warning line, never a cap
  maxAgeMs: number;      // GAS_MAX_AGE_MS (default 30,000)
  fallbackUsd: number;   // used when no fresh live reading (the old $0.05)
  minSamples: number;    // GAS_MIN_SAMPLES (default 10)
}

// Reads a positive number from the settings, or uses the default (a typo
// like "1,3" must never switch the margin off).
function num(v: string | undefined, dflt: number, lo: number, hi: number): number {
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
}

export function gasSettingsFromEnv(env: Record<string, string | undefined> = process.env): GasSettings {
  return {
    fromLive: !/^(0|false|off|no)$/i.test((env.GAS_FROM_LIVE ?? '').trim()),
    margin: num(env.GAS_MARGIN, 1.3, 1, 5),          // never below 1x: the margin can only add
    minUsd: num(env.GAS_MIN_USD, 0.01, 0, 10),
    maxUsd: num(env.GAS_MAX_USD, 0.5, 0.001, 1_000),
    maxAgeMs: num(env.GAS_MAX_AGE_MS, 30_000, 1_000, 600_000),
    fallbackUsd: 0.05,
    minSamples: Math.round(num(env.GAS_MIN_SAMPLES, 10, 1, 1_000)),
  };
}

// Fork-measured gas of our contract (Phase 3, see shadowMain OUR_GAS_OWN):
// ~311k-359k own money, ~453k-501k with a flash loan. Midpoints.
export const DEFAULT_GAS_OWN = 335_000;
export const DEFAULT_GAS_LOAN = 477_000;

// Executor hop kinds (executorCalldata.ts KIND_*) as short names for the keys.
const KIND_NAME: Record<number, string> = { 0: 'V2', 1: 'Solidly', 2: 'V3', 3: 'V4', 4: 'V4hook' };

// Calibration key for a 2-pool trade: exchange mix (sorted, so A->B and B->A
// share one key) + funding. Example: "2p:V2+V3:own".
export function twoPoolKey(kinds: number[], loan: boolean): string {
  const mix = kinds.map((k) => KIND_NAME[k] ?? `k${k}`).sort().join('+');
  return `2p:${mix}:${loan ? 'loan' : 'own'}`;
}
// Every 2-pool sample also counts toward this "any exchange mix" key, used
// when the caller doesn't know the exchanges (e.g. the gap scanner's quick filter).
export function twoPoolAnyKey(loan: boolean): string { return `2p:any:${loan ? 'loan' : 'own'}`; }
// Loops: by number of pools. Example: "loop:3".
export function loopKey(pools: number): string { return `loop:${pools}`; }

// The fork-measured default for a calibration key (what is used until the
// key has enough samples of its own).
export function defaultUnitsFor(key: string): number {
  const loop = /^loop:(\d+)$/.exec(key);
  if (loop) return loopGasUnits(Number(loop[1]));
  return key.endsWith(':loan') ? DEFAULT_GAS_LOAN : DEFAULT_GAS_OWN;
}

// Calibration key for a trade given its executor hop kinds: 2 hops = a
// 2-pool trade (by exchange mix + funding), more = a loop (by pool count).
export function routeKeyFor(kinds: number[], loan: boolean): string {
  return kinds.length === 2 ? twoPoolKey(kinds, loan) : loopKey(kinds.length);
}

// Sane range for one sample of gas units (anything outside is a bad reading).
export const MIN_SAMPLE_UNITS = 50_000;
export const MAX_SAMPLE_UNITS = 5_000_000;

// Middle value of a list (average of the two middle ones for an even count).
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ----------------------------------------------------------------------------
// Rolling record of real gas used, per kind of trade.
// ----------------------------------------------------------------------------
export class GasCalibration {
  private samples = new Map<string, number[]>();
  private dirty = false;
  private lastSaveMs = 0;

  constructor(
    private readonly file: string | null = null,      // null = memory only (tests)
    private readonly maxPerKey = 50,                    // rolling window per kind
    private readonly now: () => number = Date.now,
  ) {
    if (file) this.load();
  }

  // Add one measurement. Returns false if it was rejected as implausible.
  add(key: string, units: number | bigint): boolean {
    const u = Number(units);
    if (!Number.isFinite(u) || u < MIN_SAMPLE_UNITS || u > MAX_SAMPLE_UNITS) return false;
    const push = (k: string) => {
      const list = this.samples.get(k) ?? [];
      list.push(Math.round(u));
      if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
      this.samples.set(k, list);
    };
    push(key);
    // 2-pool samples also feed the funding-wide "any mix" key.
    const m = /^2p:[^:]+:(own|loan)$/.exec(key);
    if (m && !key.startsWith('2p:any:')) push(twoPoolAnyKey(m[1] === 'loan'));
    this.dirty = true;
    this.maybeSave();
    return true;
  }

  count(key: string): number { return this.samples.get(key)?.length ?? 0; }
  median(key: string): number | null { return median(this.samples.get(key) ?? []); }

  // Units to use: the median once there are enough samples, else the default.
  units(key: string, defaultUnits: number, minSamples: number): { units: number; calibrated: boolean; samples: number } {
    const n = this.count(key);
    const med = n >= minSamples ? this.median(key) : null;
    return med !== null ? { units: med, calibrated: true, samples: n } : { units: defaultUnits, calibrated: false, samples: n };
  }

  // Everything, for the save file and tests.
  snapshot(): Record<string, number[]> {
    const o: Record<string, number[]> = {};
    for (const [k, v] of this.samples) o[k] = [...v];
    return o;
  }

  load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const s = raw?.samples ?? {};
      for (const k of Object.keys(s)) {
        const list = (Array.isArray(s[k]) ? s[k] : []).map(Number)
          .filter((u: number) => Number.isFinite(u) && u >= MIN_SAMPLE_UNITS && u <= MAX_SAMPLE_UNITS);
        if (list.length) this.samples.set(k, list.slice(-this.maxPerKey));
      }
    } catch { /* bad file: start empty (the defaults still apply) */ }
  }

  // Write at most once a minute (temp file + rename, never half a file).
  // Never throws: a disk problem must not affect trading.
  maybeSave(force = false): void {
    if (!this.file || !this.dirty) return;
    const t = this.now();
    if (!force && t - this.lastSaveMs < 60_000) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify({ savedAt: new Date(t).toISOString(), samples: this.snapshot() }) + '\n');
      renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
      this.lastSaveMs = t;
    } catch { /* best effort */ }
  }
}

// ----------------------------------------------------------------------------
// The live gas price the bot already keeps (execution/fastSender.ts reads the
// block + parent-chain posting cost every 2 s).
// ----------------------------------------------------------------------------
export interface LiveGasSource {
  // USD cost of `units` gas + current parent-chain posting gas, at the
  // current base fee. null = gas price or ETH price unknown.
  gasCostUsdFor(units: bigint, ethUsd: number | null | undefined): number | null;
  // When the gas price was last read (ms since 1970; 0 = never).
  readonly gasReadAtMs: number;
}

export type GasSourceKind = 'live' | 'fallback' | 'old';
export interface GasEstimate {
  usd: number;           // the number the profit maths subtracts
  source: GasSourceKind; // live reading, $0.05 fallback, or the old method (switch off)
  units: number;         // gas units assumed (before parent-chain posting gas)
  calibrated: boolean;   // units from our own trades (true) or fork-measured defaults
  samples: number;       // how many samples that kind of trade has
  tooHigh: boolean;      // above GAS_MAX_USD (still used)
}

export class GasModel {
  // Report counters (since start).
  readonly counts = { live: 0, fallback: 0, old: 0, tooHigh: 0 };
  private lastStale: string | null = null;

  constructor(
    readonly settings: GasSettings,
    readonly calibration: GasCalibration,
    private readonly source: () => LiveGasSource | null,
    private readonly ethUsd: () => number | null | undefined,
    // The old estimate (switch off): fastSender.gasCostUsd(eth) ?? fallback.
    private readonly oldUsd: (fallback: number) => number,
    private readonly now: () => number = Date.now,
  ) {}

  // Gas for one trade of kind `key` (defaultUnits when not calibrated yet).
  // `fallback`: what to use with no fresh reading (callers pass $0.05; a few
  // research paths pass their own, e.g. $2).
  estimate(key: string, defaultUnits: number, fallback = this.settings.fallbackUsd): GasEstimate {
    const s = this.settings;
    if (!s.fromLive) {
      this.counts.old++;
      return { usd: this.oldUsd(fallback), source: 'old', units: 0, calibrated: false, samples: 0, tooHigh: false };
    }
    const u = this.calibration.units(key, defaultUnits, s.minSamples);
    const src = this.source();
    const fresh = !!src && src.gasReadAtMs > 0 && this.now() - src.gasReadAtMs <= s.maxAgeMs;
    const raw = fresh ? src!.gasCostUsdFor(BigInt(Math.round(u.units)), this.ethUsd()) : null;
    if (raw === null || !Number.isFinite(raw) || raw < 0) {
      this.counts.fallback++;
      this.lastStale = !src || !src.gasReadAtMs ? 'no gas reading yet' : !fresh ? 'gas reading too old' : 'ETH price unknown';
      return { usd: fallback, source: 'fallback', units: u.units, calibrated: u.calibrated, samples: u.samples, tooHigh: false };
    }
    this.lastStale = null;
    const usd = Math.max(s.minUsd, raw * s.margin);
    const tooHigh = usd > s.maxUsd;
    if (tooHigh) this.counts.tooHigh++;
    this.counts.live++;
    return { usd, source: 'live', units: u.units, calibrated: u.calibrated, samples: u.samples, tooHigh };
  }

  // A 2-pool trade. kinds = the two executor hop kinds when known.
  twoPool(loan: boolean, kinds?: number[], fallback?: number): GasEstimate {
    const dflt = loan ? DEFAULT_GAS_LOAN : DEFAULT_GAS_OWN;
    if (kinds && kinds.length === 2) {
      const exact = this.calibration.count(twoPoolKey(kinds, loan)) >= this.settings.minSamples;
      if (exact) return this.estimate(twoPoolKey(kinds, loan), dflt, fallback);
    }
    // No (or too few) samples for this exact exchange mix: the funding-wide median.
    return this.estimate(twoPoolAnyKey(loan), dflt, fallback);
  }
  twoPoolUsd(loan: boolean, kinds?: number[], fallback?: number): number { return this.twoPool(loan, kinds, fallback).usd; }

  // A loop of `pools` pools (own money, as the practice checks run them).
  // Calibrated loop samples when there are enough; otherwise the existing
  // per-pool scaling of the 2-pool own-money estimate (loopTrader.loopGasUsd).
  loopUsd(pools: number, fallback?: number): number {
    if (!this.settings.fromLive) return loopGasUsd(this.oldUsd(fallback ?? this.settings.fallbackUsd), pools);
    const k = loopKey(pools);
    if (this.calibration.count(k) >= this.settings.minSamples) return this.estimate(k, loopGasUnits(pools), fallback).usd;
    const two = this.twoPool(false, undefined, fallback);
    return loopGasUsd(two.usd, pools);
  }

  // One live receipt of our own trade. gasUsed = receipt.gasUsed;
  // gasUsedForL1 = Arbitrum's parent-chain part of it (taken out, because
  // the live estimate adds the CURRENT posting cost separately). Reverted
  // trades count only if they ran most of the route (>= 60% of the expected
  // gas): an early revert (e.g. "too late") used far less gas than a real
  // trade and would make every estimate too low.
  noteReceipt(key: string, gasUsed: bigint, gasUsedForL1: bigint | null, success: boolean, defaultUnits: number): boolean {
    const l2 = gasUsed - (gasUsedForL1 !== null && gasUsedForL1 >= 0n && gasUsedForL1 < gasUsed ? gasUsedForL1 : 0n);
    if (!success && Number(l2) < defaultUnits * 0.6) return false;
    return this.calibration.add(key, l2);
  }

  // One practice check that reported the gas it used (eth_simulateV1 replay).
  notePractice(key: string, gasUsed: bigint): boolean { return this.calibration.add(key, gasUsed); }

  // Why the last estimate fell back (null = it didn't).
  get staleReason(): string | null { return this.lastStale; }
}

// The hourly report line:
//   "Costs used: gas 2.1¢ (live, margin 1.3x; calibrated from 14 trades) · dynamic fees from events: 3 pools"
export function costsLine(est: GasEstimate, settings: GasSettings, dynamicFromEvents: number, dynamicWaiting = 0, staleReason: string | null = null): string {
  const c = (usd: number) => `${(usd * 100).toFixed(usd < 0.1 ? 2 : 1)}¢`;
  let how: string;
  if (est.source === 'old') how = 'old estimate, GAS_FROM_LIVE off';
  else if (est.source === 'fallback') how = `fallback: ${staleReason ?? 'no fresh gas reading'}`;
  else how = `live, margin ${settings.margin}x; ${est.calibrated ? `calibrated from ${est.samples} trades` : `fork-measured gas, ${est.samples}/${settings.minSamples} samples so far`}${est.tooHigh ? '; ABOVE GAS_MAX_USD' : ''}`;
  const fees = `dynamic fees from events: ${dynamicFromEvents} pool${dynamicFromEvents === 1 ? '' : 's'}${dynamicWaiting ? ` (${dynamicWaiting} waiting for a first trade)` : ''}`;
  return `Costs used: gas ${c(est.usd)} (${how}) · ${fees}`;
}
