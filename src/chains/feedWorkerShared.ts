import { parseFeedFrame, parseFeedMessages, maxSequenceNumber, defineLazyFrom, decodeFeedTx, FeedMsg, FeedTx } from './nitroFeed';

// ============================================================================
// FEED HELPER THREAD: the parts both sides share (Oct 26, owner approved
// "build the helper thread").
//
// Plain English:
//   The bot used to do ALL of this on its one main thread, for every message
//   the Robinhood sequencer feed sends (~10 a second, more when busy):
//     1. receive the websocket message and un-zip it (permessage-deflate)
//     2. turn the text into an object (JSON.parse)
//     3. unpack every transaction in it, and work out its fingerprint (hash)
//     4. read `to` / call data / ETH amount of each transaction (light read)
//   Live CPU profiles: steps 1-4 were about a quarter of the main thread's
//   work, time it could not spend on fire-first triggers.
//
//   With FEED_WORKER=1 a helper thread ("worker", chains/feedWorkerEntry.ts)
//   does steps 1-4 and sends the main thread ONE small package per feed
//   message (packFeedFrame below). The main thread only rebuilds the same
//   objects it used to build itself (unpackFeedFrame below) and then does
//   exactly what it did before, in the same order: fast-check hand-off,
//   order buffer + trigger entry point, repeat check, trade decoder, rival
//   watch. Every decision stays on the main thread.
//
//   Same results: a test (src/test/feedWorker.test.ts) checks that the
//   helper's packages turn back into exactly the objects the old in-thread
//   code makes (hashes, raw bytes, sequence numbers, order).
//
// Switch: FEED_WORKER in .env. Missing / 0 (default) = the old way, nothing
// changes and no thread is started. 1 (or on) = helper thread.
// ============================================================================

// Reads the FEED_WORKER switch (same style as core/gapScanner.ts gapScanEnabled).
export function feedWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.FEED_WORKER ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

// ----------------------------------------------------------------------------
// CLOCKS (the trigger entry point's "recv" / "parsed" timings)
//
// Plain English: performance.now() counts milliseconds from a starting point
// ("time origin"), and each thread may have its OWN starting point. So a
// performance.now() reading taken in the helper thread can't be compared
// with one taken on the main thread as is. Instead the helper sends
// performance.timeOrigin + performance.now() (an absolute time, ms since
// 1970 with decimals), and the main thread turns it back into its own
// performance.now() scale by subtracting ITS performance.timeOrigin
// (toMainHr). On Node 22 both starting points happen to be the same (checked
// Oct 26), but the conversion keeps it right even if that ever changes.
// ----------------------------------------------------------------------------
export const absNow = (): number => performance.timeOrigin + performance.now();
export const toMainHr = (abs: number): number => abs - performance.timeOrigin;

// ---- Messages between the threads -----------------------------------------

// Main thread -> helper.
export type ToFeedWorker =
  | { t: 'init'; url: string; lastSeq: number; wantText: boolean; wantMsgs: boolean; connectTimeoutMs: number }
  | { t: 'taps'; wantText: boolean; wantMsgs: boolean }   // which extras the main thread wants
  | { t: 'connect'; c: number }                           // open connection number c (drops the old one)
  | { t: 'drop'; c: number }                              // main gave up on connection c: close it
  | { t: 'close' }                                        // close the socket (disconnect)
  | { t: 'crash' };                                       // tests only: make the helper fail

// One feed message, packed by the helper. "Columns" (one list per field)
// instead of one small object per transaction: much less work to copy
// between threads. Each signed transaction's text (raw) and hash is sent
// ONCE per package (raws / hashes) even when both the order buffer list and
// the trade decoder list hold it; the lists below point into it by number.
export interface FeedFrameOut {
  t: 'frame';
  c: number;            // connection number it came from
  at: number;           // Date.now() when it arrived in the helper (same wall clock as the main thread)
  recvAbs: number;      // absolute time it arrived (see CLOCKS above)
  parsedAbs: number;    // absolute time the helper finished unpacking it
  text?: string;        // the raw text, only when the fast check wants it (setRawFrameTap)
  bad?: true;           // not valid JSON: dropped, as before
  raws: string[];       // signed transactions (0x text), each once
  hashes: string[];     // their hashes, same order
  // Order buffer list (parseFeedMessages), only when the main thread has a
  // feed message tap (setFeedMsgTap). n[k] = how many transactions message k
  // has; tx = all their numbers (into raws / hashes), message after message.
  m?: { seq: number[]; ts: number[]; l1: number[]; complete: boolean[]; why: (string | null)[]; n: number[]; tx: number[] };
  seq: number | null;   // highest sequence number in the message (maxSequenceNumber)
  repeat?: true;        // already seen (reconnect backlog): no trades to decode
  // Trade decoder list (parseFeedFrame), only when not a repeat.
  f?: { seq: (number | null)[]; tx: number[]; idx: number[]; to: string[]; data: string[]; value: string[]; from?: (string | null)[] };
}

// Helper -> main thread.
export type FromFeedWorker =
  | { t: 'ready' }
  | { t: 'open'; c: number }
  | { t: 'error'; c: number; msg: string }
  | { t: 'closed'; c: number }
  | { t: 'log'; line: string; level?: 'warn' }
  | FeedFrameOut;

// What the helper remembers between feed messages: the highest sequence
// number seen so far (the repeat check), exactly like robinhoodChain.ts.
export interface FeedWorkerState { lastSeq: number }

// ----------------------------------------------------------------------------
// HELPER SIDE: one websocket message -> one package. Same steps, same order,
// same rules as the old main-thread code in robinhoodChain.ts. Pure (no
// thread needed), so tests can call it directly. Never throws.
// ----------------------------------------------------------------------------
export function packFeedFrame(
  text: string, st: FeedWorkerState,
  o: { c: number; at: number; recvAbs: number; wantText: boolean; wantMsgs: boolean },
): FeedFrameOut {
  const out: FeedFrameOut = { t: 'frame', c: o.c, at: o.at, recvAbs: o.recvAbs, parsedAbs: 0, raws: [], hashes: [], seq: null };
  if (o.wantText) out.text = text;
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { out.bad = true; out.parsedAbs = absNow(); return out; }

  // Each signed transaction once (raw text -> its number in raws / hashes).
  const slot = new Map<string, number>();
  const idOf = (raw: string, hash: string): number => {
    let i = slot.get(raw);
    if (i === undefined) { i = out.raws.length; slot.set(raw, i); out.raws.push(raw); out.hashes.push(hash); }
    return i;
  };

  // 1. Order buffer list: only messages newer than the last one seen (unless
  //    FEED_SKIP_REPEATS=0), worked out BEFORE the repeat check, as before.
  if (o.wantMsgs) {
    try {
      const after = process.env.FEED_SKIP_REPEATS === '0' ? undefined : st.lastSeq;
      const fm = parseFeedMessages(parsed, after);
      const m = { seq: [] as number[], ts: [] as number[], l1: [] as number[], complete: [] as boolean[], why: [] as (string | null)[], n: [] as number[], tx: [] as number[] };
      for (const x of fm) {
        m.seq.push(x.seq); m.ts.push(x.ts); m.l1.push(x.l1); m.complete.push(x.complete);
        m.why.push(x.why === undefined ? null : x.why); m.n.push(x.txs.length);
        for (const t of x.txs) m.tx.push(idOf(t.raw, t.hash));
      }
      out.m = m;
    } catch { /* never breaks the feed (as before) */ }
  }

  // 2. Repeat check: a message we already had (reconnect backlog) carries
  //    no new trades.
  const seq = maxSequenceNumber(parsed);
  out.seq = seq;
  if (seq !== null) {
    if (seq <= st.lastSeq) { out.repeat = true; out.parsedAbs = absNow(); return out; }
    st.lastSeq = seq;
  }

  // 3. Trade decoder list (light read: to / data / ETH amount). The sender
  //    stays lazy (worked out on the main thread only if someone asks), as
  //    before; with FEED_LAZY_SENDER=0 the helper works it out now instead.
  try {
    const txs = parseFeedFrame(parsed);
    const eager = process.env.FEED_LAZY_SENDER === '0';
    const f = { seq: [] as (number | null)[], tx: [] as number[], idx: [] as number[], to: [] as string[], data: [] as string[], value: [] as string[], ...(eager ? { from: [] as (string | null)[] } : {}) };
    for (const t of txs) {
      f.seq.push(t.sequenceNumber); f.tx.push(idOf(t.raw, t.hash)); f.idx.push(t.txIndex);
      f.to.push(t.to); f.data.push(t.data); f.value.push(t.value);
      if (f.from) f.from.push(t.from);
    }
    out.f = f;
  } catch { /* parseFeedFrame never throws; belt and braces */ }
  out.parsedAbs = absNow();
  return out;
}

// ----------------------------------------------------------------------------
// MAIN THREAD SIDE: package -> the very same objects the old code built.
// ----------------------------------------------------------------------------

// The order buffer list (FeedMsg[], same fields, same key order as
// nitroFeed.ts parseFeedMessages). [] when the package has none.
export function unpackFeedMsgs(p: FeedFrameOut): FeedMsg[] {
  const m = p.m;
  if (!m) return [];
  const out: FeedMsg[] = [];
  let k = 0;
  for (let i = 0; i < m.seq.length; i++) {
    const txs: { hash: string; raw: string }[] = [];
    const n = m.n[i] ?? 0;
    for (let j = 0; j < n; j++, k++) { const id = m.tx[k]!; txs.push({ hash: p.hashes[id]!, raw: p.raws[id]! }); }
    const fm: FeedMsg = { seq: m.seq[i]!, ts: m.ts[i]!, l1: m.l1[i]!, txs, complete: m.complete[i]! };
    const why = m.why[i];
    if (why !== null && why !== undefined) fm.why = why;
    out.push(fm);
  }
  return out;
}

// The trade decoder list (FeedTx[], same fields as nitroFeed.ts
// parseFeedFrame). The sender is lazy (ethers works it out on first read,
// on this thread, exactly as before) unless the helper already sent it.
export function unpackFeedTxs(p: FeedFrameOut): FeedTx[] {
  const f = p.f;
  if (!f) return [];
  const out: FeedTx[] = [];
  for (let i = 0; i < f.tx.length; i++) {
    const id = f.tx[i]!;
    const raw = p.raws[id]!;
    const t = { sequenceNumber: f.seq[i] ?? null, hash: p.hashes[id]!, to: f.to[i]!, data: f.data[i]!, value: f.value[i]!, raw, txIndex: f.idx[i]! } as FeedTx;
    if (f.from) t.from = f.from[i] ?? null;
    else defineLazyFrom(t, () => decodeFeedTx(raw));
    out.push(t);
  }
  return out;
}
