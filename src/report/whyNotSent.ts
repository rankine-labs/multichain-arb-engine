// ============================================================================
// WHY NOT SENT (live, Oct 20, owner approved)
//
// Plain English:
//   Every live chance that reaches the send step (follow-a-trade or sitting
//   gap) is counted here, and so is what happened to it: sent, or the reason
//   it was stopped. Every 10 minutes one line goes to the log and Telegram:
//     Live (last 10 min): 12 chances · 1 sent · 6 real check said loss ·
//     3 pair blocked · 2 under minimum
//   Before this, the bot counted the reasons but never showed them, so a
//   quiet hour could mean "nothing found" or "everything blocked" and you
//   couldn't tell which. Reporting only: never changes what is traded.
// ============================================================================

export interface WhyWindow { chances: number; sent: number; reasons: Map<string, number> }

// Raw block reasons (as the send path writes them) grouped into a few plain
// words. Anything unknown keeps its own text, shortened.
export function plainReason(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes('check first') && r.includes('lose')) return 'real check said loss';
  if (r.includes('check first') && r.includes('fail')) return 'real check said it would fail';
  if (r.includes('check first') && r.includes('under the')) return 'real check: too small';
  if (r.includes('check first') && (r.includes('busy') || r.includes('not possible'))) return 'check node busy';
  if (r.includes('check first') && r.includes('not in a block')) return 'followed trade too slow to land';
  if (r.includes('check first')) return 'real check said no';
  if (r.includes('blocked for live') || r.includes('pool pair blocked')) return 'pair blocked (failed recently)';
  if (r.includes('benched')) return 'pair benched (keeps losing)';
  if (r.includes('send minimum')) return 'under minimum';
  if (r.includes('own money too low') || r.includes('no approved') || r.includes('lender')) return 'no money/lender for it';
  if (r.includes('outlier')) return 'too good to be true';
  if (r.includes('allowlist')) return 'coin not on safe list';
  if (r.includes('not executable') || r.includes('not cleared') || r.includes('exchange')) return 'exchange not live yet';
  if (r.includes('auto-vetted')) return 'new coin: over its limit';
  if (r.includes('send rate')) return 'too many sends this minute';
  if (r.includes('loss cap')) return 'daily loss cap reached';
  if (r.includes('kill switch')) return 'kill switch on';
  if (r.includes('stale') || r.includes('live checks')) return 'bot not ready (block info / checks)';
  return raw.replace(/\s+/g, ' ').slice(0, 40);
}

export class WhyNotSent {
  private w: WhyWindow = { chances: 0, sent: 0, reasons: new Map() };

  chance() { this.w.chances++; }
  sent() { this.w.sent++; }
  blocked(raw: string) {
    const k = plainReason(raw);
    this.w.reasons.set(k, (this.w.reasons.get(k) ?? 0) + 1);
    // Bounded: at most 50 different reasons are kept per window.
    if (this.w.reasons.size > 50) this.w.reasons.delete(this.w.reasons.keys().next().value as string);
  }

  // Hands back this window and starts a new one.
  take(): WhyWindow {
    const out = this.w;
    this.w = { chances: 0, sent: 0, reasons: new Map() };
    return out;
  }
}

// The one line ("Live (last 10 min): ..."), or null when nothing happened.
export function formatWhyNotSent(w: WhyWindow, minutes: number): string | null {
  if (!w.chances && !w.sent && !w.reasons.size) return null;
  const parts = [`${w.chances} chance${w.chances === 1 ? '' : 's'}`, `${w.sent} sent`];
  for (const [k, v] of [...w.reasons.entries()].sort((a, b) => b[1] - a[1])) parts.push(`${v} ${k}`);
  return `Live (last ${minutes} min): ${parts.join(' · ')}`;
}
