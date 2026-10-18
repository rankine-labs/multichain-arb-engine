import { ethers } from 'ethers';

// ============================================================================
// LIVE COIN RULE: no meme coins in real trades (Oct 17; OFF by default since Oct 18)
//
// Plain English:
//   The owner's live rule: we hold only USDG and WETH, and real trades may
//   only pass through reputable coins, never meme coins. Until now nothing
//   in the code enforced the "no meme coins" part: any coin in the top-80
//   pool scan was allowed. This rule decides which coins a REAL trade may
//   touch. Practice is unchanged (it still tests everything).
//
//   A coin is allowed live when it is:
//     1. USDG or WETH (our own money), or
//     2. an official Robinhood stock token: its name ends with
//        "Robinhood Token" AND it is a beacon proxy using the SAME beacon as
//        Robinhood's NVDA token (checked on chain, so a copycat that only
//        copies the name is refused), or
//     3. listed in LIVE_EXTRA_COINS (comma-separated addresses), for other
//        reputable coins the owner approves (for example cbBTC).
//   Anything else is refused for real trades and counted as "left out" in
//   "could earn live".
//
//   Coins are looked up once (two small reads) and remembered. A coin not
//   looked up yet counts as "not allowed" for that moment, and the lookup
//   starts in the background, so a trade is never delayed by it.
//
// Checked on chain Oct 17 (read-only coin probe): SPY, NVDA, TSLA, META,
// AAPL, GOOGL, GLD, SPCX, MSTR, CRCL, AMC, HIMS, USO, PLTR, MU, INTC, AMD,
// GME, LLY, MRNA, RBLX and SGOV are all official (same beacon, name ends
// "Robinhood Token"). Refused unless listed: cbBTC (Coinbase Wrapped BTC),
// U (United Stables), and the meme coins (CASHCAT, PONS, VIRTUAL, and the
// "NET" in NET/USDG, which is a meme coin called NetNet, not Cloudflare).
//
// Settings: since Oct 18 the rule is OFF by default (owner decision: a meme
// coin in the middle of a trade can only cost gas, because every trade must
// end with more USDG/WETH than it started with or it is cancelled). Real
// trades may then use any VETTED coin (the safety gate's coin checks, the
// $300 limit for auto-vetted coins and the outlier guard all still apply).
// LIVE_COIN_RULE=on turns the no-meme-coin rule back on.
// LIVE_EXTRA_COINS=0x...,0x... adds approved coins (when the rule is on).
// ============================================================================

// EIP-1967 beacon slot, and the beacon behind official Robinhood stock
// tokens (read from NVDA 0xd0601ce1..., NVDA probe run 38375863215).
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
export const ROBINHOOD_TOKEN_BEACON = '0xe10b6f6b275de231345c20d14ab812db62151b00';
const NAME = new ethers.Interface(['function name() view returns (string)']);
const MAX_REMEMBERED = 5_000; // memory guard

export type CoinVerdict = 'allowed' | 'refused' | 'unknown';

export class LiveCoinRule {
  private known = new Map<string, { ok: boolean; why: string }>();
  private pending = new Set<string>();
  readonly on: boolean;
  private readonly always: Set<string>;

  constructor(
    private readonly provider: { getStorage(a: string, s: string): Promise<string>; call(tx: { to: string; data: string }): Promise<string> },
    base: string[],
    env: Record<string, string | undefined> = process.env,
  ) {
    // Off unless LIVE_COIN_RULE is on / 1 / true (owner decision Oct 18).
    this.on = ['on', '1', 'true'].includes(String(env.LIVE_COIN_RULE ?? '').trim().toLowerCase());
    const extra = String(env.LIVE_EXTRA_COINS ?? '').split(',').map((x) => x.trim()).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x));
    this.always = new Set([...base, ...extra].map((x) => x.toLowerCase()));
  }

  // Is this coin allowed in a real trade? Never waits: unknown coins start a
  // background lookup and count as not allowed this time.
  verdict(token: string): CoinVerdict {
    if (!this.on) return 'allowed';
    const t = String(token).toLowerCase();
    if (this.always.has(t)) return 'allowed';
    const k = this.known.get(t);
    if (k) return k.ok ? 'allowed' : 'refused';
    void this.lookup(t);
    return 'unknown';
  }

  // Why a set of coins can't be traded live, or null if all are allowed.
  blocker(tokens: string[]): string | null {
    for (const t of tokens) {
      const v = this.verdict(t);
      if (v === 'refused') return `coin ${t.slice(0, 10)} is not on the live coin list (not USDG/WETH, not an official Robinhood stock token, not in LIVE_EXTRA_COINS)`;
      if (v === 'unknown') return `coin ${t.slice(0, 10)} not checked yet for the live coin list`;
    }
    return null;
  }

  // Background check of one coin (beacon + name). Errors leave it unknown
  // so it is retried next time; a clear "no" is remembered.
  async lookup(t: string): Promise<void> {
    if (this.pending.has(t) || this.known.has(t)) return;
    this.pending.add(t);
    try {
      const raw = await this.provider.getStorage(t, BEACON_SLOT);
      const beacon = '0x' + String(raw).slice(-40).toLowerCase();
      let name = '';
      try { name = String(NAME.decodeFunctionResult('name', await this.provider.call({ to: t, data: NAME.encodeFunctionData('name') }))[0]); } catch { name = ''; }
      const ok = beacon === ROBINHOOD_TOKEN_BEACON && /Robinhood Token\s*$/i.test(name);
      if (this.known.size >= MAX_REMEMBERED) this.known.clear();
      this.known.set(t, { ok, why: ok ? `official Robinhood token (${name})` : `not official (name "${name.slice(0, 40)}", beacon ${beacon.slice(0, 10)})` });
    } catch { /* node busy: try again next time */ }
    finally { this.pending.delete(t); }
  }

  // For the status log: how many coins were checked and allowed.
  stats(): { checked: number; allowed: number } {
    let allowed = 0;
    for (const v of this.known.values()) if (v.ok) allowed++;
    return { checked: this.known.size, allowed };
  }
}
