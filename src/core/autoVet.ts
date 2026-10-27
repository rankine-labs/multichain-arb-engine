import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// AUTO-VET -- coins earn a place on the vetted list by passing practice checks.
//
// Plain English:
//   Only "vetted" coins can be traded live or count in the practice totals.
//   The vetted list used to be just the coins of the top 80 pairs from the
//   chain-wide scan. In market hours about 2 of every 3 gaps the bot checked
//   were on other coins, so they could never count or trade.
//
//   Now a coin is vetted automatically once its practice checks show it behaves
//   like a normal coin:
//     - at least MIN_CHECKS completed checks (default 3): the full buy-and-sell
//       round trip ran on the real chain, whatever the result
//     - at least MIN_WINS of them profitable (default 1): proof the coin can be
//       sold back for more than it cost, so no hidden sell tax eating it all
//     - and never a "the coin refused to move" failure or an impossible
//       profit: those mark the coin BLOCKED for BLOCK_DAYS (default 7), the
//       signs of a trap coin (transfer blocks, taxes, broken price data)
//   Checks that failed for node reasons (busy, timeouts) don't count either way.
//
//   Coins vetted this way get a smaller live trade limit (see shadowMain:
//   AUTO_VET_MAX_TRADE_USD), because a coin's owner could still change its
//   rules later. Saved to disk so a restart keeps what was learned.
// ============================================================================

export type CheckOutcome = 'profit' | 'loss' | 'fail';

// Failures that mean "this coin itself is a problem", not "the node was busy".
const BAD_COIN = /transfer|exceeds balance|insufficient balance|STF|TF\b|token refused|tax|blacklist|implausible|honeypot/i;

interface Tally { checks: number; wins: number; lastMs: number }

export class AutoVet {
  private tallies = new Map<string, Tally>();
  private vetted = new Map<string, number>();    // token -> when it was vetted (ms)
  private blocked = new Map<string, number>();   // token -> blocked until (ms)

  constructor(
    // True for coins already on the vetted list from the scan (never tracked here).
    private readonly isBaseVetted: (token: string) => boolean,
    private readonly minChecks = Number(process.env.AUTO_VET_MIN_CHECKS ?? 3),
    private readonly minWins = Number(process.env.AUTO_VET_MIN_WINS ?? 1),
    private readonly blockMs = Number(process.env.AUTO_VET_BLOCK_DAYS ?? 7) * 24 * 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isAutoVetted(token: string): boolean { return this.vetted.has(token.toLowerCase()); }
  // Every auto-vetted coin (lowercase), for the fast lane's shared state file.
  vettedList(): string[] { return [...this.vetted.keys()]; }
  isBlocked(token: string): boolean { return (this.blocked.get(token.toLowerCase()) ?? 0) > this.now(); }
  vettedTokens(): string[] { return [...this.vetted.keys()]; }

  // Record one completed practice check on a trade through these coins.
  // Returns coins that just became vetted (add to the safety gate) and coins
  // that were auto-vetted but just failed like a trap coin (remove them).
  record(tokens: string[], outcome: CheckOutcome, reason = ''): { added: string[]; removed: string[] } {
    const fresh: string[] = [], removed: string[] = [];
    const t = this.now();
    for (const raw of tokens) {
      const tok = raw.toLowerCase();
      if (this.isBaseVetted(tok) && !this.vetted.has(tok)) continue;   // scan-vetted coins aren't judged here
      if (outcome === 'fail') {
        // Node trouble doesn't count; a coin-level failure blocks the coin,
        // and takes it off the list if it had been auto-vetted.
        if (BAD_COIN.test(reason)) {
          this.blocked.set(tok, t + this.blockMs); this.tallies.delete(tok);
          if (this.vetted.delete(tok)) removed.push(tok);
        }
        continue;
      }
      if (this.vetted.has(tok)) continue;
      if (this.isBlocked(tok)) continue;
      const s = this.tallies.get(tok) ?? { checks: 0, wins: 0, lastMs: 0 };
      s.checks++; s.lastMs = t;
      if (outcome === 'profit') s.wins++;
      this.tallies.set(tok, s);
      if (s.checks >= this.minChecks && s.wins >= this.minWins) {
        this.vetted.set(tok, t);
        this.tallies.delete(tok);
        fresh.push(tok);
      }
    }
    if (this.tallies.size > 5_000) this.prune();
    return { added: fresh, removed };
  }

  stats() { return { vetted: this.vetted.size, blocked: [...this.blocked.values()].filter((u) => u > this.now()).length, watching: this.tallies.size }; }

  // Forget tallies not seen for 3 days (they never qualified).
  private prune() {
    const old = this.now() - 3 * 24 * 60 * 60_000;
    for (const [k, s] of this.tallies) if (s.lastMs < old) this.tallies.delete(k);
  }

  save(file: string) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify({ vetted: [...this.vetted], blocked: [...this.blocked], tallies: [...this.tallies] }));
      renameSync(file + '.tmp', file);
    } catch { /* best effort */ }
  }

  // Returns the vetted coins loaded (to add to the safety gate at start).
  load(file: string): string[] {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      this.vetted = new Map(d.vetted ?? []);
      this.blocked = new Map(d.blocked ?? []);
      this.tallies = new Map(d.tallies ?? []);
      // A coin blocked since it was vetted stays out.
      for (const k of this.vetted.keys()) if (this.isBlocked(k)) this.vetted.delete(k);
      return [...this.vetted.keys()];
    } catch { return []; }
  }
}
