// ============================================================================
// GROUPS FRESH SKIP (Nov 1, freeze fix 9): should the bot rebuild the coin
// groups right after a restart?
//
// Plain English:
//   The coin groups build (core/tokenGroups.ts) checks the money in every
//   USDG/WETH pool on the chain (~545,000 on Nov 1) and takes ~26 minutes.
//   It used to run after EVERY restart, even when the saved list
//   (data/token-groups.json) was minutes old. Deploys and restarts are
//   frequent, so the bot spent a large part of its time inside that build.
//
//   Rule now: a saved list younger than the normal rebuild interval (6 h)
//   is kept as it is; the rebuild is booked for when it turns 6 h old (at
//   least 3 minutes after start, like before). An old, missing or
//   future-dated list rebuilds right away, exactly as before.
//
// Switch: GROUPS_FRESH_SKIP=0 = always rebuild after a restart (old way).
// ============================================================================

export function groupsStartupPlan(
  updatedAt: unknown, now: number, everyMs: number,
  env: Record<string, string | undefined> = process.env,
): { rebuildNow: boolean; laterMs: number } {
  if ((env.GROUPS_FRESH_SKIP ?? '').trim() === '0') return { rebuildNow: true, laterMs: 0 };
  // A saved list without a usable time, or dated in the future: rebuild (old way).
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt > now) return { rebuildNow: true, laterMs: 0 };
  const age = now - updatedAt;
  if (age >= everyMs) return { rebuildNow: true, laterMs: 0 };
  // Never earlier than the first setup (3 min after start).
  return { rebuildNow: false, laterMs: Math.max(3 * 60_000 + 30_000, everyMs - age) };
}
