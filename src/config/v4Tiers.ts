// ============================================================================
// UNISWAP V4 FEE SETTINGS WE LOOK UP (Oct 16, owner approved)
//
// Plain English:
//   A Uniswap V4 pool has no address. Its id is a fingerprint of
//   (coin 0, coin 1, fee, tick spacing, hook). To find a pair's V4 pools the
//   bot computes those fingerprints and asks V4 whether each one exists.
//   Until Oct 16 it only tried the 4 "standard" settings. The Oct 16 pair
//   workbook showed 39 real, hook-free V4 pools at OTHER settings (for
//   example SPY/USDG 0.05% with spacing 5, $1M; WETH/USDG native ETH 0.046%
//   with spacing 9, $730k; MSTR/USDG 0.25% with spacing 25, $1.4M). The bot
//   never saw them. Each setting below was recovered from a real workbook
//   pool id (the fingerprint matched exactly), so none of them is a guess.
//
//   Our deployed contract trades any hook-free V4 pool (the fee and tick
//   spacing travel inside each trade; fork test ForkNewVenues.t.sol traded
//   the two biggest WETH/USDG ones both ways, CI run 38996170909).
//   Oct 16, 23:02 (owner approved for go-live): these pools may be traded
//   for real, like any standard V4 pool. RH_V4_EXTRA_LIVE=0 in .env makes
//   them practice only again (the live send then refuses them).
//
// Settings (.env, optional):
//   RH_V4_EXTRA_TIERS=0          look up only the 4 standard settings (old behaviour)
//   RH_V4_MORE_TIERS=fee:ts,...  add more settings, e.g. "750:15,4000:80"
//   RH_V4_EXTRA_LIVE=0           pools at the extra settings: practice only
// ============================================================================

export type V4Tier = [fee: number, tickSpacing: number];

// The 4 standard settings (fee in pips, 3000 = 0.30%). Live-tradable.
export const STANDARD_V4_TIERS: V4Tier[] = [[500, 10], [3000, 60], [10000, 200], [100, 1]];

// Non-standard settings seen on real hook-free pools (Oct 16 workbook).
// Comment = an example pool that uses it.
export const EXTRA_V4_TIERS: V4Tier[] = [
  [200, 4],      // WETH/USDG 0.02%
  [310, 3],      // META/USDG 0.031%
  [450, 9],      // USDG/WETH 0.045%
  [460, 9],      // WETH(ETH)/USDG 0.046%, $730k
  [500, 1],      // ETH/WETH 0.05%
  [500, 5],      // SPY/USDG 0.05%, $980k; amc/USDG
  [800, 5],      // syrupUSDG/USDG 0.08%
  [1000, 2],     // NVDA/WETH 0.1%
  [1000, 10],    // amc/USDG 0.1%; BABA/USDG
  [1200, 15],    // USO/USDG 0.12%
  [1500, 15],    // cbBTC/USDG 0.15%, $840k; PLTR/USDG
  [2000, 20],    // HOOD/USDG 0.2%
  [2300, 23],    // AI/USDG 0.23%
  [2400, 24],    // MSTR/USDG 0.24%, $770k
  [2500, 25],    // MSTR/USDG 0.25%, $1.4M; EDEL, FLOCK, hXMAX
  [2690, 54],    // CASHCAT/USDG 0.269%
  [3000, 30],    // CRCL/USDG 0.3%, $650k
  [5000, 50],    // OPENAIx1L/USDG 0.5%
  [7500, 75],    // TSM/USDG 0.75%
  [8000, 80],    // ORBIO/USDG 0.8%
  [9000, 90],    // HIMS, NET, LIT, hOHM 0.9%
  [9900, 99],    // NBIS/USDG 0.99%
  [10000, 100],  // PRIORS, HOOKR 1%
  [19000, 190],  // VRAX/USDG 1.9%
  [25000, 250],  // HYDX/USDG 2.5%
  [28000, 280],  // BOW/USDG 2.8%
  [32000, 320],  // WOLFPACK/USDG 3.2%
];

// Reads "fee:ts,fee:ts" (bad entries are skipped, loudly).
export function parseTiers(raw: string | undefined): V4Tier[] {
  if (!raw || !raw.trim()) return [];
  const out: V4Tier[] = [];
  for (const part of raw.split(',')) {
    const m = part.trim().match(/^(\d+):(-?\d+)$/);
    const fee = m ? Number(m[1]) : NaN, ts = m ? Number(m[2]) : NaN;
    // V4 limits: fee under 100% (1,000,000 pips), tick spacing 1..32767.
    if (m && fee >= 0 && fee < 1_000_000 && ts >= 1 && ts <= 32767) out.push([fee, ts]);
    else console.warn(`[config] RH_V4_MORE_TIERS: skipped "${part.trim()}" (want fee:tickSpacing, e.g. 750:15)`);
  }
  return out;
}

// The full list, standard first, no duplicates.
export function buildLookupTiers(env: Record<string, string | undefined> = process.env): V4Tier[] {
  const list: V4Tier[] = [...STANDARD_V4_TIERS];
  if (env.RH_V4_EXTRA_TIERS !== '0' && env.RH_V4_EXTRA_TIERS !== 'off') list.push(...EXTRA_V4_TIERS, ...parseTiers(env.RH_V4_MORE_TIERS));
  const seen = new Set<string>();
  return list.filter(([f, t]) => { const k = `${f}:${t}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// What the pair watcher and the chain-wide scan look up.
export const V4_LOOKUP_TIERS: V4Tier[] = buildLookupTiers();

export function isStandardV4Tier(fee: number, tickSpacing: number): boolean {
  return STANDARD_V4_TIERS.some(([f, t]) => f === fee && t === tickSpacing);
}

// Live send refuses these pools (practice only). Returns the reason, or null.
// Hook-free V4 pools at a non-standard setting are live-tradable since the
// owner's go-live approval (Oct 16); RH_V4_EXTRA_LIVE=0 makes them practice
// only again.
export function practiceOnlyReason(pool: { v4?: { fee: number; tickSpacing: number; hooks?: string } }, env: Record<string, string | undefined> = process.env): string | null {
  const v = pool.v4;
  if (!v) return null;
  if (env.RH_V4_EXTRA_LIVE !== '0' && env.RH_V4_EXTRA_LIVE !== 'off') return null;
  const hookless = !v.hooks || /^0x0{40}$/i.test(v.hooks);
  if (hookless && !isStandardV4Tier(v.fee, v.tickSpacing)) return `Uniswap V4 pool at a non-standard setting (${v.fee / 10_000}% / spacing ${v.tickSpacing}), practice only`;
  return null;
}
