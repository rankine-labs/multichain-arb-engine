// ============================================================================
// GAP CREDIT -- count one still-open standing gap only once.
//
// Plain English:
//   The standing-gap scanner re-checks a gap that is still open once it has
//   at least doubled in size (shadowMain, gapConfirmedOpen). In practice mode
//   nobody closes our gaps, so a gap that grows from $150 to $400 used to be
//   added to "would have made" twice: $150 + $400 = $550. One trade can only
//   take the gap once, so the honest total for one open gap is its biggest
//   confirmed size ($400). This keeps, per open gap, how much we already
//   counted and hands back only the extra.
//
//   Reporting only: it never decides whether a gap is checked or sent.
// ============================================================================

export class GapCredit {
  // Open gap key ("buyPool>sellPool") -> dollars already counted for it.
  private counted = new Map<string, number>();

  constructor(private readonly maxKeys = 2_000) {}

  // A gap was confirmed at netUsd (after gas). Returns how much of it is new
  // money to count: all of it the first time, only the growth after that,
  // and 0 if it is not bigger than what we already counted.
  credit(key: string, netUsd: number): number {
    if (!(netUsd > 0) || !Number.isFinite(netUsd)) return 0;
    const before = this.counted.get(key) ?? 0;
    if (netUsd <= before) return 0;
    // Memory guard, same size limit as the scanner's own maps.
    if (!this.counted.has(key) && this.counted.size >= this.maxKeys) this.counted.clear();
    this.counted.set(key, netUsd);
    return netUsd - before;
  }

  // The gap closed (left the scan's list): a later gap on the same pools is a new chance.
  closed(key: string) { this.counted.delete(key); }

  // Keys still remembered (for the scanner's "drop the closed ones" loop).
  keys(): IterableIterator<string> { return this.counted.keys(); }
}
