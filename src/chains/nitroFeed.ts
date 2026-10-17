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
}

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

// On by default; FEED_LAZY_HASH=0 turns it off (read per call so tests can switch it).
function lazyHash(): boolean { return process.env.FEED_LAZY_HASH !== '0'; }

// Adds a `hash` property that hashes the raw signed bytes the first time it
// is read and caches the answer. Enumerable, so it still looks like a field.
export function defineLazyHash(target: { hash?: string }, raw: string): void {
  let value: string | null = null;
  Object.defineProperty(target, 'hash', {
    enumerable: true,
    configurable: true,
    get() { if (value === null) value = keccak256(raw); return value; },
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

    for (const { tx, raw } of parseL2MessageRaw(bytes)) {
      // Every field read is guarded: ethers re-validates some transactions
      // lazily (e.g. a priority fee above the max fee, which Robinhood's
      // sequencer accepts) and throws from inside getters like tx.hash.
      try {
        if (!tx.to || !tx.data || tx.data === '0x') continue; // plain transfers aren't swaps
        // A tx hash is keccak256 of its raw signed bytes: no ethers validation involved.
        const out = { sequenceNumber: seq, to: tx.to, data: tx.data, value: tx.value.toString() } as FeedTx;
        // HASH IS WORKED OUT ONLY WHEN SOMEONE ASKS FOR IT (experiment, Oct 16).
        // keccak256 of the raw bytes, computed on first read and remembered.
        // FEED_LAZY_HASH=0 restores the old eager behaviour.
        if (lazyHash()) defineLazyHash(out, raw);
        else out.hash = keccak256(raw);
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
