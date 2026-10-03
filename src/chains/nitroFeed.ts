import { Transaction } from 'ethers';

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
  from: string | null;
}

// Pulls every signed transaction (that calls a contract) out of one l2Msg.
export function parseL2Message(bytes: Uint8Array, depth = 0): Transaction[] {
  if (bytes.length === 0 || depth > MAX_BATCH_DEPTH) return [];
  const kind = bytes[0];
  const body = bytes.subarray(1);

  if (kind === L2_KIND_SIGNED_TX) {
    try {
      return [Transaction.from('0x' + Buffer.from(body).toString('hex'))];
    } catch {
      return []; // not a tx we can parse; skip, don't crash
    }
  }

  if (kind === L2_KIND_BATCH) {
    const out: Transaction[] = [];
    let i = 0;
    while (i + 8 <= body.length) {
      const len = Number(Buffer.from(body.subarray(i, i + 8)).readBigUInt64BE());
      i += 8;
      if (len <= 0 || i + len > body.length) break; // truncated / malformed
      out.push(...parseL2Message(body.subarray(i, i + len), depth + 1));
      i += len;
    }
    return out;
  }

  return [];
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

    for (const tx of parseL2Message(bytes)) {
      if (!tx.to || !tx.data || tx.data === '0x') continue; // plain transfers aren't swaps
      let from: string | null = null;
      try { from = tx.from; } catch { /* unsigned or bad signature */ }
      txs.push({ sequenceNumber: seq, hash: tx.hash ?? '', to: tx.to, data: tx.data, from });
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
