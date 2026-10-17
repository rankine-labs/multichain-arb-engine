// ============================================================================
// UNISWAP V4 POOLS WITH HOOKS WE READ (Oct 16, owner approved: price reading
// and practice checks only, never real trades)
//
// Plain English:
//   About 60 of the Uniswap V4 pools in the Oct 16 pair workbook have a
//   "hook": extra code the pool runs around each trade. Our bot only read
//   hook-free V4 pools (plus Fables, which publishes its own pool list), so
//   these were invisible, including the second-biggest WETH/USDG pool on the
//   chain (~$23M, ~$68M a day).
//
//   A V4 hook's ADDRESS says what it is allowed to do: the last 14 bits are
//   permission flags checked by Uniswap itself. Two of them ("return delta"
//   on swaps) let a hook change how many coins a trade pays or gets. A pool
//   whose hook has neither can only (a) pick the fee or (b) refuse a trade,
//   so its price maths are the normal V4 maths. Only pools like that are
//   listed here; hooks that can change amounts (custom curves, taxes) are
//   left out on purpose.
//
//   Every entry comes from the pool's own Initialize event on the Uniswap V4
//   PoolManager, so the key (coins, fee, tick spacing, hook) is exactly what
//   the chain stored. Where the list comes from:
//     - the file data/robinhood-hooked-pools.json on the server, written by
//       the read-only script scripts/hooked-pool-keys.ts (run it on the
//       server: the free public node keeps no history, so it can't find
//       these events; the paid node can). Read once at start.
//     - entries typed in ROBINHOOD_HOOKED_POOLS below (none yet).
//   Oct 16 finding: 21 of the workbook's ~62 hooked pools, including the
//   $23M WETH/USDG pool, are Fables pools, which the bot ALREADY reads from
//   the Fables registry. This list is for the other ~41 (SPCX, BABA, U and
//   many meme coins).
//
//   Fees: the fee our maths uses is the pool's current LP fee from StateView
//   (pairWatcher.hookedFee). For "dynamic fee" pools whose LP fee reads 0,
//   a conservative 0.30% estimate is used. Every practice check is a full
//   simulation through the real hook, so a wrong fee shows up as a failed
//   check, not as counted money.
//
//   Live: refused. These pools trade through the contract's hooked-V4 trade
//   type, which is only in the contract SOURCE (fork-tested on Fables); the
//   contract deployed on chain does not have it. Real trades need a redeploy
//   and owner approval.
// ============================================================================

import { readFileSync } from 'fs';

// One hooked V4 pool given by its full key. currency0 is the zero address
// for native-ETH pools (the bot uses WETH in its place).
export interface V4ListedKey { id: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }

export interface HookedPoolEntry extends V4ListedKey {
  venue: string;     // venue id in config/robinhoodVenues.ts
  label: string;     // pair and what the workbook knew about it (liquidity, day volume)
}

// What a V4 hook address allows (Uniswap v4 Hooks.sol flag bits).
export function hookPermissions(hook: string): { beforeSwap: boolean; afterSwap: boolean; returnsSwapDelta: boolean } {
  const v = Number(BigInt(hook) & 0x3fffn);
  return { beforeSwap: (v & (1 << 7)) !== 0, afterSwap: (v & (1 << 6)) !== 0, returnsSwapDelta: (v & ((1 << 3) | (1 << 2))) !== 0 };
}

// True when the hook cannot change a swap's amounts (normal V4 price maths hold).
export function hookKeepsSwapMaths(hook: string): boolean {
  return !hookPermissions(hook).returnsSwapDelta;
}

// Filled from the probe (see header). Kept sorted by pair.
export const ROBINHOOD_HOOKED_POOLS: HookedPoolEntry[] = [];

export const HOOKED_POOLS_FILE = 'data/robinhood-hooked-pools.json';
const MAX_FILE_POOLS = 500; // memory guard

// Entries from the server file (see header). Bad entries are skipped; a
// missing or broken file just means "none".
export function loadHookedPoolFile(file = HOOKED_POOLS_FILE): HookedPoolEntry[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const list: any[] = Array.isArray(raw?.pools) ? raw.pools : [];
    const hex = (x: unknown, n: number) => typeof x === 'string' && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(x);
    return list.slice(0, MAX_FILE_POOLS).filter((p) => hex(p?.id, 64) && hex(p?.currency0, 40) && hex(p?.currency1, 40) && hex(p?.hooks, 40)
      && Number.isInteger(p?.fee) && Number.isInteger(p?.tickSpacing) && p.tickSpacing > 0)
      .map((p) => ({ venue: 'v4-hooks', label: String(p.label ?? '').slice(0, 80), id: p.id.toLowerCase(), currency0: p.currency0.toLowerCase(),
        currency1: p.currency1.toLowerCase(), fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks.toLowerCase() }));
  } catch { return []; }
}

// The keys for one venue: typed entries plus the server file, only hooks
// that keep normal swap maths (a guard against a bad entry), no duplicates.
export function listedKeysFor(venueId: string, fromFile: HookedPoolEntry[] = loadHookedPoolFile()): V4ListedKey[] {
  const seen = new Set<string>();
  return [...ROBINHOOD_HOOKED_POOLS, ...fromFile].filter((p) => p.venue === venueId && hookKeepsSwapMaths(p.hooks) && !seen.has(p.id) && !!seen.add(p.id))
    .map(({ id, currency0, currency1, fee, tickSpacing, hooks }) => ({ id, currency0, currency1, fee, tickSpacing, hooks }));
}
