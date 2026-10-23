import { Transaction, keccak256 } from 'ethers';

// ============================================================================
// NITRO SEQUENCER FEED PARSER (Robinhood Chain = Arbitrum Orbit / Nitro)
//
// Plain English:
//   The sequencer feed doesn't send "to / data" for each transaction. It
//   sends frames like:
//     { "version": 1, "messages": [ { "sequenceNumber": N,
//         "message": { "message": { "header": { "kind": 3, ... },
//                                   "l2Msg": "<base64 bytes>" }, ... } } ] }
//   and the transactions are packed inside l2Msg. This file unpacks them.
//
// l2Msg layout (first byte = kind):
//   4 (SignedTx): the rest is a normal signed Ethereum transaction
//   3 (Batch):    a list of [8-byte big-endian length][nested l2Msg], each
//                 nested message starting with its own kind byte
//   others (unsigned/contract/heartbeat/compressed): skipped
//
// Header kind 3 = "L2 message" (user transactions). Other header kinds
// (deposits, chain init, batch posting reports) carry no swaps we can use.
//
// The bot used to pass whole frames to the decoder, which expected plain
// { to, data } fields that never exist here, so no Robinhood transaction
// was ever decoded.
// ============================================================================

const HEADER_KIND_L2_MESSAGE = 3;
const L2_KIND_BATCH = 3;
const L2_KIND_SIGNED_TX = 4;
const MAX_BATCH_DEPTH = 16; // safety cap on nested batches

export interface FeedTx {
  sequenceNumber: number | null;
  hash: string;
  to: string;
  data: string;
  value: string;   // wei, decimal string (native-coin swaps carry their amount here)
  from: string | null;
  // TRIGGER-FIRST (execution/triggerFirst.ts): the signed transaction bytes
  // exactly as the sequencer sent them, and the transaction's place inside
  // its feed message (0 = first). The fast check replays these bytes.
  raw: string;
  txIndex: number;
}

// ----------------------------------------------------------------------------
// TRIGGER-FIRST: every feed message, complete, in order
//
// Plain English: to work out "our trade right after the trade we follow"
// without waiting for a block, the fast check must re-run EVERY transaction
// the sequencer put between its copy and our trade, in order. So for each
// feed message we keep: its sequence number (= its block), its block time
// and parent-chain block number, and ALL its signed transactions (also
// plain transfers, which the trade decoder skips). If a message holds
// anything we can't hand over exactly (a deposit, a retryable, a compressed
// or unsigned transaction, a broken batch), it is marked NOT complete: a
// check that needs it then says "unknown" instead of guessing.
// ----------------------------------------------------------------------------
export interface FeedMsgTx { hash: string; raw: string }
export interface FeedMsg {
  seq: number;
  ts: number;            // block time (seconds) from the message header
  l1: number;            // parent-chain block number from the header
  txs: FeedMsgTx[];      // every signed transaction, in sequencer order
  complete: boolean;     // false = holds something we can't replay
  why?: string;          // why not complete
}

const L2_KIND_HEARTBEAT = 6; // carries nothing

// Pulls every signed transaction (that calls a contract) out of one l2Msg.
// Transactions plus their raw signed bytes (the raw bytes give the tx hash
// directly, see parseFeedFrame).
type ParsedTx = { tx: Transaction; raw: string };

export function parseL2Message(bytes: Uint8Array, depth = 0): Transaction[] {
  return parseL2MessageRaw(bytes, depth).map((p) => p.tx);
}

function parseL2MessageRaw(bytes: Uint8Array, depth = 0): ParsedTx[] {
  if (bytes.length === 0 || depth > MAX_BATCH_DEPTH) return [];
  const kind = bytes[0];
  const body = bytes.subarray(1);

  if (kind === L2_KIND_SIGNED_TX) {
    try {
      const raw = '0x' + Buffer.from(body).toString('hex');
      return [{ tx: Transaction.from(raw), raw }];
    } catch {
      return []; // not a tx we can parse; skip, don't crash
    }
  }

  if (kind === L2_KIND_BATCH) {
    const out: ParsedTx[] = [];
    let i = 0;
    while (i + 8 <= body.length) {
      const len = Number(Buffer.from(body.subarray(i, i + 8)).readBigUInt64BE());
      i += 8;
      if (len <= 0 || i + len > body.length) break; // truncated / malformed
      out.push(...parseL2MessageRaw(body.subarray(i, i + len), depth + 1));
      i += len;
    }
    return out;
  }

  return [];
}

// Every signed transaction of one l2Msg, strictly: anything that isn't a
// signed transaction or a batch of them is written into `problems`
// (the message is then not complete). Raw bytes + hash only: no decoding,
// the fast check does that itself.
function collectL2Strict(bytes: Uint8Array, depth: number, out: FeedMsgTx[], problems: string[]): void {
  if (depth > MAX_BATCH_DEPTH) { problems.push('batch nested too deep'); return; }
  if (bytes.length === 0) { problems.push('empty l2 message'); return; }
  const kind = bytes[0];
  const body = bytes.subarray(1);
  if (kind === L2_KIND_SIGNED_TX) {
    if (!body.length) { problems.push('empty signed transaction'); return; }
    const raw = '0x' + Buffer.from(body).toString('hex');
    out.push({ hash: keccak256(raw), raw });
    return;
  }
  if (kind === L2_KIND_BATCH) {
    let i = 0;
    while (i < body.length) {
      if (i + 8 > body.length) { problems.push('broken batch (length)'); return; }
      const len = Number(Buffer.from(body.subarray(i, i + 8)).readBigUInt64BE());
      i += 8;
      if (len <= 0 || i + len > body.length) { problems.push('broken batch (entry)'); return; }
      collectL2Strict(body.subarray(i, i + len), depth + 1, out, problems);
      i += len;
    }
    return;
  }
  if (kind === L2_KIND_HEARTBEAT) return;
  problems.push(`l2 message kind ${kind}`);
}

// One feed message -> FeedMsg (null: no sequence number, can't be placed).
function feedMsgOf(m: any): FeedMsg | null {
  const seq = m?.sequenceNumber;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
  const inner = m?.message?.message;
  const header = inner?.header ?? {};
  const ts = Number(header.timestamp ?? 0);
  const l1 = Number(header.blockNumber ?? 0);
  const out: FeedMsg = { seq, ts: Number.isFinite(ts) ? ts : 0, l1: Number.isFinite(l1) ? l1 : 0, txs: [], complete: true };
  const problems: string[] = [];
  if (header.kind !== HEADER_KIND_L2_MESSAGE) {
    // Deposits, retryables, batch-posting reports, ...: they change state
    // we can't reproduce here.
    problems.push(`header kind ${header.kind}`);
  } else if (typeof inner?.l2Msg !== 'string') {
    problems.push('no l2Msg');
  } else {
    try { collectL2Strict(Buffer.from(inner.l2Msg, 'base64'), 0, out.txs, problems); }
    catch { problems.push('l2Msg unreadable'); }
  }
  if (problems.length) { out.complete = false; out.why = problems[0]; }
  return out;
}

// Every message of a frame, complete (see above). Never throws.
export function parseFeedMessages(frame: unknown): FeedMsg[] {
  const messages = (frame as any)?.messages;
  if (!Array.isArray(messages)) return [];
  const out: FeedMsg[] = [];
  for (const m of messages) {
    try { const f = feedMsgOf(m); if (f) out.push(f); } catch { /* skip */ }
  }
  return out;
}

// Sender of a transaction, or null if it can't be recovered (unsigned or a
// bad signature). Never throws.
function safeFrom(tx: Transaction): string | null {
  try { return tx.from; } catch { return null; }
}

// On by default; FEED_LAZY_SENDER=0 turns it off (read per call so tests can switch it).
function lazySender(): boolean { return process.env.FEED_LAZY_SENDER !== '0'; }

// Adds a `from` property that recovers the sender the first time it is read
// and caches the answer. Enumerable, so it still shows up like a normal field.
export function defineLazyFrom(target: { from?: string | null }, tx: Transaction): void {
  let done = false;
  let value: string | null = null;
  Object.defineProperty(target, 'from', {
    enumerable: true,
    configurable: true,
    get() { if (!done) { value = safeFrom(tx); done = true; } return value; },
  });
}

// Parses one websocket frame into the transactions it contains.
// Returns [] for anything unexpected; never throws.
export function parseFeedFrame(frame: unknown): FeedTx[] {
  const messages = (frame as any)?.messages;
  if (!Array.isArray(messages)) return [];

  const txs: FeedTx[] = [];
  for (const m of messages) {
    const inner = m?.message?.message;
    if (inner?.header?.kind !== HEADER_KIND_L2_MESSAGE || typeof inner?.l2Msg !== 'string') continue;
    const seq = typeof m?.sequenceNumber === 'number' ? m.sequenceNumber : null;

    let bytes: Uint8Array;
    try {
      bytes = Buffer.from(inner.l2Msg, 'base64');
    } catch {
      continue;
    }

    let txIndex = -1;
    for (const { tx, raw } of parseL2MessageRaw(bytes)) {
      txIndex++;
      // Every field read is guarded: ethers re-validates some transactions
      // lazily (e.g. a priority fee above the max fee, which Robinhood's
      // sequencer accepts) and throws from inside getters like tx.hash.
      try {
        if (!tx.to || !tx.data || tx.data === '0x') continue; // plain transfers aren't swaps
        // A tx hash is keccak256 of its raw signed bytes: no ethers validation involved.
        const out = { sequenceNumber: seq, hash: keccak256(raw), to: tx.to, data: tx.data, value: tx.value.toString(), raw, txIndex } as FeedTx;
        // SENDER ("from") IS WORKED OUT ONLY WHEN SOMEONE ASKS FOR IT (Oct 13).
        // Finding the sender means checking the signature, which takes about
        // 1-2 ms per transaction in JavaScript. A feed frame often holds 20-40
        // transactions, and the old code checked every signature BEFORE the bot
        // could look at any trade: ~39 ms typical wait on the hot path. Only the
        // rival tracker needs the sender, so it is now computed on first read
        // (and remembered). FEED_LAZY_SENDER=0 restores the old eager behaviour.
        if (lazySender()) defineLazyFrom(out, tx);
        else out.from = safeFrom(tx);
        txs.push(out);
      } catch { /* malformed: skip this one, keep the rest of the frame */ }
    }
  }
  return txs;
}

// Highest sequence number in a frame (for liveness tracking), or null.
export function maxSequenceNumber(frame: unknown): number | null {
  const messages = (frame as any)?.messages;
  if (!Array.isArray(messages)) return null;
  let max: number | null = null;
  for (const m of messages) {
    if (typeof m?.sequenceNumber === 'number' && (max === null || m.sequenceNumber > max)) max = m.sequenceNumber;
  }
  return max;
}
