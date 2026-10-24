import { Transaction, keccak256, getAddress } from 'ethers';

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

// ----------------------------------------------------------------------------
// DECODE EACH TRANSACTION ONCE (freeze fix, Oct 23)
//
// Plain English: every feed transaction used to be unpacked three times
// and its fingerprint (hash) worked out twice, by three different parts of
// the bot, all inside the same feed message:
//   1. the trigger-first order buffer (parseFeedMessages: hash)
//   2. the trigger entry point's "skip it?" test (trigEntry.quickSkip: unpack)
//   3. the trade decoder's list (parseFeedFrame: unpack + hash again)
// Measured on a test machine (labelled TEST numbers, 1 KB swap):
//   unpack (ethers Transaction.from) ~255 us, hash of the text form ~186 us,
//   hash of the raw bytes ~75 us. So ~0.9 ms of frozen bot per transaction,
//   ~36 ms for a busy 40-transaction message, and seconds for the backlog a
//   feed reconnect replays.
// Now: the hash is taken from the bytes we already have (same answer, no
// text-to-bytes step), and both the hash and the unpacked transaction are
// remembered for the last few thousand transactions, so the second and third
// readers get them for free. Same results, byte for byte (tested).
//
// Switch: FEED_TX_MEMO=0 turns the memory off (every reader unpacks again,
// as before). Memory: at most MEMO_MAX entries (~2 KB each), then cleared.
// ----------------------------------------------------------------------------
const MEMO_MAX = 4_096;
const hashMemo = new Map<string, string>();
const txMemo = new Map<string, Transaction | null>();
function memoOn(): boolean { return process.env.FEED_TX_MEMO !== '0'; }

// Forget everything remembered (tests: measure the first, uncached pass).
export function clearFeedTxMemo(): void { hashMemo.clear(); txMemo.clear(); }

// Hash (keccak256) of a signed transaction. `bytes` = the same transaction
// as raw bytes, when the caller already has them (saves the text-to-bytes step).
export function feedTxHash(raw: string, bytes?: Uint8Array): string {
  const on = memoOn();
  if (on) { const h = hashMemo.get(raw); if (h !== undefined) return h; }
  const h = keccak256(bytes ?? raw);
  if (on) { if (hashMemo.size >= MEMO_MAX) hashMemo.clear(); hashMemo.set(raw, h); }
  return h;
}

// The signed transaction unpacked (ethers Transaction), or null when ethers
// can't read it. Remembered (see above), so a transaction already unpacked
// by another reader is not unpacked again. Never throws.
export function decodeFeedTx(raw: string): Transaction | null {
  const on = memoOn();
  if (on) { const t = txMemo.get(raw); if (t !== undefined) return t; }
  let tx: Transaction | null;
  try { tx = Transaction.from(raw); } catch { tx = null; }
  if (on) { if (txMemo.size >= MEMO_MAX) txMemo.clear(); txMemo.set(raw, tx); }
  return tx;
}

// ----------------------------------------------------------------------------
// LIGHT READ OF A FEED TRANSACTION (freeze fix 2, Oct 24)
//
// Plain English: the feed path only needs three things from most
// transactions: who it goes to (`to`), the call data, and the ETH amount.
// ethers' full unpack (Transaction.from) works them out too, but it turns
// every byte into text and back several times: ~250 us and ~300 KB of
// throw-away memory for a 1 KB swap (TEST numbers). On a busy feed that was
// the biggest single piece of "feed tap" freezes and of the memory clean-up
// (GC) work.
//
// peekFeedTx() reads the same three fields straight from the bytes, with
// the SAME rules ethers uses to accept or refuse a transaction, for the
// common kinds (legacy, type 1, type 2 with an empty access list):
//   result object -> ethers would read it, and gives exactly these values
//   null          -> ethers would refuse it too ("unreadable")
//   undefined     -> not sure (type 3 / 4, a non-empty access list, odd
//                    text): the caller asks ethers, exactly as before
// A test compares it with ethers on thousands of real and broken
// transactions (src/test/freezeFix2.test.ts).
// The sender ("from") still comes from ethers, only when someone asks.
//
// Switch: FEED_LIGHT_DECODE=0 = always ethers (the old way).
// ----------------------------------------------------------------------------
export type FeedTxPeek = { to: string | null; data: string; value: bigint };
function lightOn(): boolean { return process.env.FEED_LIGHT_DECODE !== '0'; }

// Checksummed addresses already worked out (the same routers and pools come
// up again and again; the checksum needs a hash). Capped, then cleared.
const ADDR_MEMO_MAX = 8_192;
const addrMemo = new Map<string, string>();
function checksum(lower40: string): string {
  let a = addrMemo.get(lower40);
  if (a === undefined) {
    a = getAddress('0x' + lower40);
    if (addrMemo.size >= ADDR_MEMO_MAX) addrMemo.clear();
    addrMemo.set(lower40, a);
  }
  return a;
}

// One RLP item, read with ethers' own (lenient) rules (utils/rlp-decode.js).
// s..e = its content; next = where the following item starts; list = a list.
// null = ethers' reader would throw here (too short / runs past the end).
type RlpItem = { list: boolean; s: number; e: number; next: number };
function rlpItem(b: Uint8Array, off: number): RlpItem | null {
  const n = b.length;
  if (off >= n) return null;
  const p = b[off];
  // Length-of-length forms: the length is a big-endian number of ll bytes
  // (worked out like ethers: plain number maths).
  const longLen = (ll: number): number => {
    let len = 0;
    for (let i = 0; i < ll; i++) len = len * 256 + b[off + 1 + i];
    return len;
  };
  if (p >= 0xf8) {
    const ll = p - 0xf7;
    if (off + 1 + ll > n) return null;
    const len = longLen(ll);
    if (off + 1 + ll + len > n) return null;
    return { list: true, s: off + 1 + ll, e: off + 1 + ll + len, next: off + 1 + ll + len };
  }
  if (p >= 0xc0) {
    const len = p - 0xc0;
    if (off + 1 + len > n) return null;
    return { list: true, s: off + 1, e: off + 1 + len, next: off + 1 + len };
  }
  if (p >= 0xb8) {
    const ll = p - 0xb7;
    if (off + 1 + ll > n) return null;
    const len = longLen(ll);
    if (off + 1 + ll + len > n) return null;
    return { list: false, s: off + 1 + ll, e: off + 1 + ll + len, next: off + 1 + ll + len };
  }
  if (p >= 0x80) {
    const len = p - 0x80;
    if (off + 1 + len > n) return null;
    return { list: false, s: off + 1, e: off + 1 + len, next: off + 1 + len };
  }
  return { list: false, s: off, e: off + 1, next: off + 1 }; // a single byte is its own value
}

// The items inside a list (s..e). null = ethers' reader would throw (an
// item runs past the list's end). The items' own insides are not read: a
// nested list in a field that must be a plain value is refused anyway.
function rlpChildren(b: Uint8Array, s: number, e: number): RlpItem[] | null {
  const out: RlpItem[] = [];
  let off = s;
  while (off < e) {
    const it = rlpItem(b, off);
    if (!it || it.next > e) return null;
    out.push(it);
    off = it.next;
  }
  return out;
}

// Number of bytes once leading zero bytes are dropped.
function sigLen(b: Uint8Array, it: RlpItem): number {
  let s = it.s;
  while (s < it.e && b[s] === 0) s++;
  return it.e - s;
}
// A whole number field as ethers reads it: plain value, at most 32 bytes
// once leading zeros are dropped (ethers handleUint).
const okUint = (b: Uint8Array, it: RlpItem): boolean => !it.list && sigLen(b, it) <= 32;
// A small number field (ethers handleNumber / getNumber): at most 2^53 - 1.
function smallNum(b: Uint8Array, it: RlpItem): number | null {
  if (it.list || sigLen(b, it) > 7) return null;
  let v = 0;
  for (let i = it.s; i < it.e; i++) v = v * 256 + b[i];
  return v <= 0x1fffffffffffff ? v : null;
}
// The value as a bigint (exact for any size).
function bigOf(buf: Buffer, it: RlpItem): bigint {
  const len = it.e - it.s;
  if (len === 0) return BigInt(0);
  if (len <= 6) { let v = 0; for (let i = it.s; i < it.e; i++) v = v * 256 + buf[i]; return BigInt(v); }
  return BigInt('0x' + buf.toString('hex', it.s, it.e));
}
// `to` as ethers gives it: empty = no recipient (null); 20 bytes = the
// checksummed address; anything else = ethers refuses the transaction.
function toOf(buf: Buffer, it: RlpItem): string | null | false {
  if (it.list) return false;
  const len = it.e - it.s;
  if (len === 0) return null;
  if (len !== 20) return false;
  return checksum(buf.toString('hex', it.s, it.e));
}

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

// See the block comment above. `bytes` = the same transaction as raw bytes
// (saves the text-to-bytes step when the caller already has them).
export function peekFeedTx(raw: string, bytes?: Uint8Array): FeedTxPeek | null | undefined {
  try {
    if (typeof raw !== 'string') return undefined;
    let buf: Buffer;
    if (bytes) buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    else {
      if (!HEX_RE.test(raw)) return undefined; // odd text: let ethers decide
      buf = Buffer.from(raw.slice(2), 'hex');
    }
    if (buf.length === 0) return null; // ethers: "unsupported transaction type"
    const t = buf[0];
    if (t >= 0x7f) return peekLegacy(buf);
    if (t === 1 || t === 2) return peekTyped(buf, t);
    if (t === 3 || t === 4) return undefined; // blob / 7702: ethers reads these
    return null; // any other type byte: ethers refuses it
  } catch {
    return undefined; // never guess: ethers decides
  }
}

// Legacy: rlp([nonce, gasPrice, gasLimit, to, value, data(, v, r, s)]).
function peekLegacy(buf: Buffer): FeedTxPeek | null {
  const top = rlpItem(buf, 0);
  if (!top || top.next !== buf.length || !top.list) return null;
  const f = rlpChildren(buf, top.s, top.e);
  if (!f || (f.length !== 6 && f.length !== 9)) return null;
  if (smallNum(buf, f[0]) === null || !okUint(buf, f[1]) || !okUint(buf, f[2])) return null;
  const to = toOf(buf, f[3]);
  if (to === false || !okUint(buf, f[4]) || f[5].list) return null;
  if (f.length === 9) {
    if (!okUint(buf, f[6]) || !okUint(buf, f[7]) || !okUint(buf, f[8])) return null;
    const v = bigOf(buf, f[6]), r = bigOf(buf, f[7]), s = bigOf(buf, f[8]);
    if (!(r === BigInt(0) && s === BigInt(0))) {
      // ethers: chainId = (v - 35) / 2 (never below 0); chain 0 needs v = 27 / 28;
      // r and s are padded to 32 bytes (more raw bytes than that = refused).
      let chainId = (v - BigInt(35)) / BigInt(2);
      if (chainId < BigInt(0)) chainId = BigInt(0);
      if (chainId === BigInt(0) && v !== BigInt(27) && v !== BigInt(28)) return null;
      if (f[7].e - f[7].s > 32 || f[8].e - f[8].s > 32) return null;
    }
  }
  return { to, data: '0x' + buf.toString('hex', f[5].s, f[5].e), value: bigOf(buf, f[4]) };
}

// Type 1: 0x01 || rlp([chainId, nonce, gasPrice, gasLimit, to, value, data, accessList(, yParity, r, s)])
// Type 2: 0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, accessList(, yParity, r, s)])
function peekTyped(buf: Buffer, type: 1 | 2): FeedTxPeek | null | undefined {
  const top = rlpItem(buf, 1);
  if (!top || top.next !== buf.length || !top.list) return null;
  const f = rlpChildren(buf, top.s, top.e);
  const base = type === 2 ? 9 : 8;
  if (!f || (f.length !== base && f.length !== base + 3)) return null;
  // Number fields before `to`: chainId (uint), nonce (small), then 2 or 3 uints.
  if (!okUint(buf, f[0]) || smallNum(buf, f[1]) === null) return null;
  const toAt = type === 2 ? 5 : 4;
  for (let i = 2; i < toAt; i++) if (!okUint(buf, f[i])) return null;
  const to = toOf(buf, f[toAt]);
  if (to === false || !okUint(buf, f[toAt + 1]) || f[toAt + 2].list) return null;
  const al = f[toAt + 3];
  if (!al.list || al.e !== al.s) return undefined; // access list not empty: ethers checks it
  if (f.length === base + 3) {
    const y = smallNum(buf, f[base]);
    if (y !== 0 && y !== 1) return null;                       // ethers: "invalid yParity"
    const r = f[base + 1], s = f[base + 2];
    if (r.list || s.list || r.e - r.s > 32 || s.e - s.s > 32) return null; // ethers: padded to 32 bytes
  }
  return { to, data: '0x' + buf.toString('hex', f[toAt + 2].s, f[toAt + 2].e), value: bigOf(buf, f[toAt + 1]) };
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
      // Unpacked once and remembered (see decodeFeedTx); null = can't parse.
      const tx = decodeFeedTx(raw);
      return tx ? [{ tx, raw }] : []; // not a tx we can parse; skip, don't crash
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

// The trade decoder's pass (parseFeedFrame): every signed transaction ethers
// can read, with `to` / data / ETH amount from the light read (peekFeedTx);
// ethers unpacks only the ones the light read is not sure about. Same list,
// same order, same values as parseL2MessageRaw (tested). `body` = the raw
// bytes (the hash is taken from them).
type LightTx = { raw: string; body: Uint8Array; to: string | null; data: string; value: bigint };
function parseL2MessageLight(bytes: Uint8Array, depth = 0, out: LightTx[] = []): LightTx[] {
  if (bytes.length === 0 || depth > MAX_BATCH_DEPTH) return out;
  const kind = bytes[0];
  const body = bytes.subarray(1);
  if (kind === L2_KIND_SIGNED_TX) {
    try {
      const raw = '0x' + Buffer.from(body.buffer, body.byteOffset, body.length).toString('hex');
      const p = peekFeedTx(raw, body);
      if (p) { out.push({ raw, body, to: p.to, data: p.data, value: p.value }); return out; }
      if (p === null) return out; // ethers can't read it either: skipped, as before
      const tx = decodeFeedTx(raw); // not sure: ethers decides (remembered)
      if (tx) out.push({ raw, body, to: tx.to, data: tx.data, value: tx.value });
    } catch { /* not a tx we can parse; skip, don't crash */ }
    return out;
  }
  if (kind === L2_KIND_BATCH) {
    let i = 0;
    while (i + 8 <= body.length) {
      const len = Number(Buffer.from(body.buffer, body.byteOffset + i, 8).readBigUInt64BE());
      i += 8;
      if (len <= 0 || i + len > body.length) break; // truncated / malformed
      parseL2MessageLight(body.subarray(i, i + len), depth + 1, out);
      i += len;
    }
  }
  return out;
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
    // Hash from the bytes we already hold (same answer as hashing `raw`).
    out.push({ hash: feedTxHash(raw, body), raw });
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
// `afterSeq` (freeze fix, Oct 23): only messages with a HIGHER sequence
// number are unpacked. After a feed reconnect the broadcaster replays its
// backlog (often hundreds of messages we already have); unpacking those
// again froze the bot for no gain (the order buffer keeps one copy per
// sequence number anyway, and the trigger entry point must not treat old
// transactions as new triggers). Not given = every message, as before.
export function parseFeedMessages(frame: unknown, afterSeq?: number): FeedMsg[] {
  const messages = (frame as any)?.messages;
  if (!Array.isArray(messages)) return [];
  const out: FeedMsg[] = [];
  for (const m of messages) {
    if (afterSeq !== undefined && typeof m?.sequenceNumber === 'number' && m.sequenceNumber <= afterSeq) continue;
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
// `tx` may also be a function that unpacks the transaction only then (the
// light read above did not need ethers' full unpack until now).
export function defineLazyFrom(target: { from?: string | null }, tx: Transaction | (() => Transaction | null)): void {
  let done = false;
  let value: string | null = null;
  Object.defineProperty(target, 'from', {
    enumerable: true,
    configurable: true,
    get() {
      if (!done) {
        const t = typeof tx === 'function' ? tx() : tx;
        value = t ? safeFrom(t) : null;
        done = true;
      }
      return value;
    },
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

    // Light read (FEED_LIGHT_DECODE, default on): to / data / amount from the
    // bytes; ethers unpacks a transaction only for its sender, when asked.
    if (lightOn()) {
      let txIndex = -1;
      for (const p of parseL2MessageLight(bytes)) {
        txIndex++;
        try {
          if (!p.to || !p.data || p.data === '0x') continue; // plain transfers aren't swaps
          const raw = p.raw;
          const out = { sequenceNumber: seq, hash: feedTxHash(raw, p.body), to: p.to, data: p.data, value: p.value.toString(), raw, txIndex } as FeedTx;
          if (lazySender()) defineLazyFrom(out, () => decodeFeedTx(raw));
          else { const tx = decodeFeedTx(raw); out.from = tx ? safeFrom(tx) : null; }
          txs.push(out);
        } catch { /* malformed: skip this one, keep the rest of the frame */ }
      }
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
        // (Remembered from the order buffer's pass over the same message.)
        const out = { sequenceNumber: seq, hash: feedTxHash(raw), to: tx.to, data: tx.data, value: tx.value.toString(), raw, txIndex } as FeedTx;
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
