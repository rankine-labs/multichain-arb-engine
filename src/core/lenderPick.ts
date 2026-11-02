import type { ChainName, PoolState } from './types';

// ============================================================================
// LENDER FAST (Nov 1, freeze fix 9): "which pools may lend this coin?"
// without copying the whole pool list.
//
// Plain English:
//   Every time the bot builds a route (the route table rebuilds thousands of
//   them a minute, and each route is built at several trade sizes), it picks
//   the flash-loan lender. The old code first made a copy of EVERY cached
//   pool on the chain (tens of thousands), then threw away all but the few
//   approved lender pools, then threw away the ones that don't hold the
//   coin. Live CPU profiles (Nov 1) showed this copy-and-filter as the
//   biggest single job inside the bot's freezes (about 1.0-1.5 s of every
//   5-6 s profile), plus a lot of the memory clean-up (GC) work.
//
//   Now the bot only looks at pools that could be the answer:
//     - approved lender list set (FLASH_LENDERS_<CHAIN>): just those
//       addresses are looked up in the cache (PoolCache.atAddresses);
//     - no list, live: no lender (as before);
//     - no list, practice: the pools holding the coin (PoolCache.withToken),
//       because the lender picker drops every other pool anyway.
//   The lender picker (pickV3Lender) then runs exactly as before on that
//   smaller list. Same pools in the same order, so the same lender is
//   picked (tested against the old code in src/test/lenderFast.test.ts).
//
// Switch: LENDER_FAST=0 goes back to the old copy-everything code.
// ============================================================================

export function lenderFastOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LENDER_FAST ?? '').trim() !== '0';
}

// The approved lender list from .env, as the old code read it:
// FLASH_LENDERS_<CHAIN>, comma-separated, trimmed, lower-case, blanks dropped.
export function parseApprovedLenders(env: Record<string, string | undefined>, chain: string): Set<string> {
  return new Set(
    (env[`FLASH_LENDERS_${chain.toUpperCase()}`] ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean),
  );
}

// The parts of the pool cache used here (PoolCache has them all).
export interface LenderPoolSource {
  allForChain(chain: ChainName): PoolState[];
  withToken(chain: ChainName, token: string): PoolState[];
  atAddresses(chain: ChainName, lowerAddrs: Iterable<string>): PoolState[] | null;
}

// OLD rule (kept word for word as the reference and for LENDER_FAST=0):
// every pool on the chain, narrowed to the approved list when there is one;
// live with no list = none.
export function lenderCandidatesOld(src: LenderPoolSource, chain: ChainName, approved: Set<string>, liveNoList: boolean): PoolState[] {
  const all = src.allForChain(chain);
  if (approved.size) return all.filter((p) => approved.has(p.poolAddress.toLowerCase()));
  return liveNoList ? [] : all;
}

// NEW rule: only pools that could be picked to lend `token`. Feeding this to
// pickV3Lender gives the same pick as feeding it lenderCandidatesOld,
// because pickV3Lender keeps only pools holding `token`, keeps their order
// (filter, then a stable sort), and every pool it could keep is in here, in
// the same relative order:
//   - atAddresses = allForChain filtered to the list, same order;
//   - withToken   = allForChain filtered to pools holding the token, same order.
// The token is not filtered here when a list is set (pickV3Lender does it),
// so the list case returns exactly lenderCandidatesOld's list.
export function lenderCandidatesFor(src: LenderPoolSource, chain: ChainName, token: string, approved: Set<string>, liveNoList: boolean): PoolState[] {
  if (approved.size) return src.atAddresses(chain, approved) ?? lenderCandidatesOld(src, chain, approved, liveNoList);
  if (liveNoList) return [];
  return src.withToken(chain, token);
}
