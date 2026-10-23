// ============================================================================
// CHECK FIRST, THEN SEND: which check decides a live "follow a trade" send.
//
// Plain English: this is the order the bot tries things in, for one live
// trade that follows a trigger (shadowMain.ts fireTrade calls it; it was
// written inline there before, unchanged apart from step 0):
//
//   0. TRIGGER-FIRST (execution/triggerFirst.ts, LOCAL_SIM_TRIGGER_FIRST=on
//      and the fast check ON): its answer was asked the moment the feed
//      showed the trigger. A SURE answer decides at once: no waiting for
//      pool reports, no receipt polling, no node. Unknown -> step 1.
//   1. COPY 2 (fast check following our pools' reports), on mode, every
//      pool ready: wait for the trigger's pool reports, then check at that
//      block. Not ready / not seen in time -> step 2.
//      (Copy 2 not running: the older fast check "right after the trigger".)
//   2. THE NODE: wait for the trigger's receipt, then the node's check.
//
// Every step's answer then goes through the same verdict (decideCheckFirst)
// and every existing safeguard in fireTrade, whichever step decided.
// All the waiting / node / fast-check work is handed in (deps), so tests can
// prove step 0 never touches any of it.
// ============================================================================

export type CheckFirstDecider = 'trig_first' | 'local' | 'node';

export type CheckFirstDeps<LC, C> = {
  now: () => number;
  mark: (stage: string) => void;                  // stall finder
  // Step 0: the trigger-first answer, already asked (null = not deciding:
  // off, practice, or the fast check is not ON). toCheck turns a SURE answer
  // into the check result (profit / loss / fail); null = not usable.
  trigFirst: null | (() => Promise<C | null>);
  // Steps 1 / 2 (exactly today's behaviour).
  hasBuilt: boolean;                              // the trade could be built for a fast check
  copy2Running: () => boolean;
  copy2Deciding: () => boolean;                   // fast check ON and every route pool ready
  copy2WaitForTx: (ms: number) => Promise<number | null>;
  copy2Route: (block: number) => { at: Record<string, unknown> } | null;
  startFast: (at?: Record<string, unknown>) => LC | null;
  fastDecide: (lc: LC | null) => Promise<C | null>;
  waitForTrade: () => Promise<boolean>;
  nodeCheck: (lc: LC | null) => Promise<C>;
  noNode: (lc: LC | null) => void;
};

export type CheckFirstRun<LC, C> = {
  c: C | null;                                    // null = the trigger didn't land in time (not sent)
  decidedBy: CheckFirstDecider;
  waitMs: number;                                 // time spent waiting for the trigger to land
  fastLc: LC | null;
};

// Run steps 0-2 (see the header). Never throws on its own; a dependency that
// throws propagates exactly as the inline code did (fireTrade catches it).
export async function runCheckFirst<LC, C>(d: CheckFirstDeps<LC, C>): Promise<CheckFirstRun<LC, C>> {
  const startedMs = d.now();
  // 0. Trigger-first: a sure answer decides with no waiting at all.
  if (d.trigFirst) {
    const c = await d.trigFirst();
    if (c) {
      d.mark('check-first trigger-first');
      return { c, decidedBy: 'trig_first', waitMs: 0, fastLc: null };
    }
  }
  let fastLc: LC | null = null;
  let c: C | null = null;
  let waitMs = 0;
  let decidedBy: CheckFirstDecider = 'node';
  if (d.hasBuilt && d.copy2Running()) {
    // 1. COPY 2: answers are per block. On mode, every pool ready: wait for
    // the followed trade's pool reports (it is then in a block, no node
    // receipt polling), and ask about that block.
    if (d.copy2Deciding()) {
      const blk = await d.copy2WaitForTx(1_800);
      const route = blk !== null ? d.copy2Route(blk) : null;
      if (route) {
        waitMs = d.now() - startedMs;
        fastLc = d.startFast(route.at);
        c = await d.fastDecide(fastLc);
        if (c) { decidedBy = 'local'; d.mark('check-first fast check'); }
      }
    }
  } else if (d.hasBuilt) {
    fastLc = d.startFast();
    c = await d.fastDecide(fastLc);
    if (c) { decidedBy = 'local'; d.mark('check-first fast check'); }
  }
  if (!c) {
    // 2. The node: wait for the receipt (polled), then the node's check.
    const landed = await d.waitForTrade();
    waitMs = d.now() - startedMs;
    d.mark('check-first wait');
    if (!landed) {
      d.noNode(fastLc);
      return { c: null, decidedBy, waitMs, fastLc };
    }
    c = await d.nodeCheck(fastLc);
  }
  return { c, decidedBy, waitMs, fastLc };
}
