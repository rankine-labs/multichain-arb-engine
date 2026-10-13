import { readFileSync, mkdirSync } from 'fs';
import { writeFile, rename } from 'fs/promises';
import { dirname } from 'path';
import type { PoolState } from './types';

// ============================================================================
// V3 BALANCE BOOK -- how much money a V3 pool REALLY holds.
//
// Plain English:
//   For a Uniswap V3 style pool we normally estimate depth from its
//   "virtual reserves" (liquidity / price). That number assumes the liquidity
//   at today's price stretches forever. When a pool's liquidity is squeezed
//   into a narrow price band, the virtual number can be many times bigger
//   than the coins actually sitting in the pool: a pool holding $800 can look
//   like a $40,000 pool. That let thin pools set prices (the ORBIO problem).
//
//   The fix: read each V3 pool's real token balances (balanceOf) every
//   ~10 minutes in one bundled request, off the trading path, and cap the
//   depth estimate at what's really there:
//       executable depth = min(virtual depth near the price, real balance)
//   The real balance is the most a trade could ever take out; the virtual
//   depth tells how fast the price moves while doing so. Neither alone is
//   honest; the smaller of the two is.
//
//   V4 pools are skipped: their coins all sit together in one PoolManager,
//   so there is no per-pool balance to read. Their depth stays "virtual"
//   and the oracle labels it as such.
//
// SAVED TO DISK (Oct 13, "restart blip"): after a restart the book used to
// be empty for ~2 minutes (until the first read), so thin pools slipped back
// into the loop finder and gap scanner. Now the book is saved to
// data/v3-balances.json after every read (written to a temp file, then
// renamed, so a crash mid-write never leaves a broken file) and loaded at
// startup. Balances older than 1 hour are ignored when loading. The read
// schedule itself is unchanged.
// ============================================================================

// Default file and the oldest balance kept when loading it.
export const V3_BALANCES_FILE = 'data/v3-balances.json';
export const V3_BALANCES_MAX_AGE_MS = 60 * 60_000;

type CallMany = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;

const SEL_BALANCE = '0x70a08231'; // balanceOf(address)
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

export class V3BalanceBook {
  private bal = new Map<string, bigint>(); // "pool:token" -> raw balance
  private at = new Map<string, number>();  // "pool:token" -> when that balance was read (ms)
  private readAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  // Raw balance of `token` held by `pool`, or undefined if not read yet.
  get(pool: string, token: string): bigint | undefined {
    return this.bal.get(`${pool.toLowerCase()}:${token.toLowerCase()}`);
  }

  size(): number { return this.bal.size; }
  ageMs(): number { return this.readAt ? this.now() - this.readAt : Infinity; }

  // Read both token balances of every V3 pool (not V4) in one bundled call.
  // Returns how many balances were read. Failures keep the old values.
  async refresh(callMany: CallMany, pools: PoolState[], maxPools = 1_500): Promise<number> {
    const v3 = pools.filter((p) => p.poolType === 'v3' && !p.v4 && /^0x[0-9a-fA-F]{40}$/.test(p.poolAddress)).slice(0, maxPools);
    if (!v3.length) return 0;
    const calls = v3.flatMap((p) => [
      { target: p.tokenA, data: SEL_BALANCE + pad(p.poolAddress) },
      { target: p.tokenB, data: SEL_BALANCE + pad(p.poolAddress) },
    ]);
    const res = await callMany(calls);
    if (this.bal.size > 10_000) { this.bal.clear(); this.at.clear(); } // bounded memory (refilled just below)
    const t = this.now();
    let n = 0;
    v3.forEach((p, i) => {
      for (const [k, tok] of [[0, p.tokenA], [1, p.tokenB]] as const) {
        const r = res[i * 2 + k];
        if (!r || r === '0x') continue;
        const key = `${p.poolAddress.toLowerCase()}:${tok.toLowerCase()}`;
        try { this.bal.set(key, BigInt(r.slice(0, 66))); this.at.set(key, t); n++; } catch { /* bad answer: skip */ }
      }
    });
    this.readAt = this.now();
    return n;
  }

  // Save every balance (with when it was read) to `file`. Written to a temp
  // file first, then renamed over the real one, so the file on disk is
  // always either the old copy or the new one, never half written.
  // Best effort: a disk problem is reported in the return value, never thrown.
  async save(file: string = V3_BALANCES_FILE): Promise<boolean> {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const entries = [...this.bal].map(([k, v]) => [k, v.toString(), this.at.get(k) ?? this.readAt]);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify({ savedAt: this.now(), entries }));
      await rename(tmp, file);
      return true;
    } catch { return false; }
  }

  // Load balances saved by save(). Balances read more than maxAgeMs ago are
  // skipped (a pool's coins can change a lot in an hour). Returns how many
  // were loaded. A missing or broken file just loads nothing.
  load(file: string = V3_BALANCES_FILE, maxAgeMs = V3_BALANCES_MAX_AGE_MS): number {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return 0; }
    const entries = (raw as { entries?: unknown })?.entries;
    if (!Array.isArray(entries)) return 0;
    const now = this.now();
    let n = 0, newest = 0;
    for (const e of entries) {
      if (!Array.isArray(e) || e.length < 3) continue;
      const [k, v, at] = e as [unknown, unknown, unknown];
      if (typeof k !== 'string' || typeof v !== 'string' || typeof at !== 'number') continue;
      if (!(now - at <= maxAgeMs) || at > now + 60_000) continue; // too old, or a time from the future: skip
      if (this.bal.has(k)) continue;         // a fresh read already got this one
      try { this.bal.set(k, BigInt(v)); this.at.set(k, at); n++; newest = Math.max(newest, at); } catch { /* bad value: skip */ }
    }
    if (newest > this.readAt) this.readAt = newest;
    return n;
  }
}
