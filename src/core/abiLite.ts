import { ethers } from 'ethers';

// ============================================================================
// FAST ABI READER (feed speed, Oct 24)
//
// Plain English:
//   Every swap in the trade feed is "ABI encoded": the router's arguments
//   packed into 32-byte slots. The bot reads them with ethers' AbiCoder,
//   which is correct but slow for this job: on every call it builds a fresh
//   set of reader objects for each argument type, copies the bytes around
//   several times, and works out a checksum (a hash) for every address. On
//   the test machine that was 120-280 us per swap, most of the per-trade
//   time before the bot can decide anything (the server is ~2x slower, and a
//   busy feed message holds 20-50 trades).
//
//   This reader does the same reading in one pass over the bytes:
//     - the bytes are read straight from the hex text (no copies),
//     - an address's checksummed form is remembered (addresses repeat all
//       the time: the same coins and routers), and
//     - the answer is built with ethers' own Result type, with the same
//       names, so the code that uses it can't tell the difference.
//
//   SAFETY RULE: it only answers when the data is laid out exactly the
//   standard way (every pointer inside the data, on a 32-byte boundary,
//   every value fitting its type, nothing read twice). For anything else
//   (broken, cut short, odd or hostile data) it answers "not sure" and the
//   caller uses ethers exactly as before, so ethers' own answer or error
//   comes out. Tests compare it with ethers on thousands of normal, broken
//   and random inputs.
//
//   Switch: FEED_FAST_ABI=0 = always ethers (the old way).
// ============================================================================

const ethersCoder = ethers.AbiCoder.defaultAbiCoder();
let LITE_ON = process.env.FEED_FAST_ABI !== '0';
// Tests only: switch the fast reader on / off.
export function setFastAbi(on: boolean): void { LITE_ON = on; }
export function fastAbiOn(): boolean { return LITE_ON; }

// "Not sure": thrown inside the reader, caught at the top (never escapes).
const NOT_SURE: unique symbol = Symbol('abi-lite-not-sure');

// ---- checksummed addresses, remembered ----------------------------------------------------------
// ethers.getAddress of a lower-case address never changes, so it is safe to
// remember. Bounded: cleared when it holds 20,000 addresses.
const checksums = new Map<string, string>();
export function checksumAddress(lower: string): string {
  let c = checksums.get(lower);
  if (c === undefined) {
    c = ethers.getAddress(lower);
    if (checksums.size >= 20_000) checksums.clear();
    checksums.set(lower, c);
  }
  return c;
}
// Same as ethers.getAddress(addr) for any input (invalid input throws the
// same error, from ethers itself); remembered for valid ones.
export function getAddressFast(addr: string): string {
  if (typeof addr === 'string' && addr.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
    const lower = addr.toLowerCase();
    const c = checksumAddress(lower);
    // A mixed-case input must already be the checksummed form (ethers
    // checks that and throws otherwise): let ethers decide those.
    if (addr === lower || addr === c || addr === addr.toUpperCase().replace('0X', '0x')) return c;
  }
  return ethers.getAddress(addr);
}

// ---- types, worked out once -------------------------------------------------------------------
const typeLists = new Map<string, readonly ethers.ParamType[]>();
function paramTypes(types: ReadonlyArray<string | ethers.ParamType>): readonly ethers.ParamType[] | null {
  if (types.every((t) => typeof t === 'string')) {
    const key = (types as string[]).join('|');
    let pts = typeLists.get(key);
    if (!pts) {
      pts = (types as string[]).map((t) => ethers.ParamType.from(t));
      if (typeLists.size < 500) typeLists.set(key, pts); // only the code's own fixed layouts: a handful
    }
    return pts;
  }
  if (types.every((t) => t instanceof ethers.ParamType)) return types as readonly ethers.ParamType[];
  return null;
}
const dynCache = new WeakMap<ethers.ParamType, boolean>();
function isDynamic(t: ethers.ParamType): boolean {
  let d = dynCache.get(t);
  if (d !== undefined) return d;
  if (t.baseType === 'bytes' || t.baseType === 'string') d = true;
  else if (t.baseType === 'array') d = t.arrayLength === -1 || isDynamic(t.arrayChildren!);
  else if (t.baseType === 'tuple') d = t.components!.some(isDynamic);
  else d = false;
  dynCache.set(t, d);
  return d;
}
// Head size (bytes) of a type that is NOT dynamic.
function staticSize(t: ethers.ParamType): number {
  if (t.baseType === 'tuple') return t.components!.reduce((s, c) => s + staticSize(c), 0);
  if (t.baseType === 'array') return t.arrayLength * staticSize(t.arrayChildren!);
  return 32;
}

// ---- the reader ---------------------------------------------------------------------------------
// The bytes are kept as hex text (2 characters per byte, after the "0x").
interface St { hex: string; len: number; read: number }
const ZERO64 = '0'.repeat(64);
// The 32-byte word at byte `pos`, as 64 hex characters (lower case).
function word(st: St, pos: number): string {
  if (pos < 0 || pos + 32 > st.len) throw NOT_SURE;
  st.read += 32;
  if (st.read > st.len) throw NOT_SURE; // something read twice: not the standard layout
  return st.hex.slice(2 + 2 * pos, 2 + 2 * pos + 64);
}
// A length / pointer: small, whole number.
function index(st: St, pos: number): number {
  const w = word(st, pos);
  if (w.slice(0, 56) !== ZERO64.slice(0, 56)) throw NOT_SURE; // over 2^32: not a real length here
  return parseInt(w.slice(56), 16);
}
function bitsOf(t: ethers.ParamType, prefix: string): number {
  const n = t.type.length > prefix.length ? Number(t.type.slice(prefix.length)) : 256;
  if (!Number.isInteger(n) || n < 8 || n > 256 || n % 8 !== 0) throw NOT_SURE;
  return n;
}
const TWO256 = 1n << 256n;
function elementary(st: St, t: ethers.ParamType, pos: number): unknown {
  const bt = t.baseType;
  if (bt === 'address') {
    const w = word(st, pos);
    if (w.slice(0, 24) !== ZERO64.slice(0, 24)) throw NOT_SURE; // ethers: deferred error
    return checksumAddress('0x' + w.slice(24));
  }
  if (bt === 'bool') {
    const w = word(st, pos);
    if (w === ZERO64) return false;
    if (w === ZERO64.slice(0, 63) + '1') return true;
    throw NOT_SURE;
  }
  if (bt.startsWith('uint')) {
    const bits = bitsOf(t, 'uint');
    const w = word(st, pos);
    const top = (256 - bits) / 4;
    if (top && w.slice(0, top) !== ZERO64.slice(0, top)) throw NOT_SURE; // ethers would cut it short silently
    return BigInt('0x' + w);
  }
  if (bt.startsWith('int')) {
    const bits = bitsOf(t, 'int');
    const w = word(st, pos);
    let v = BigInt('0x' + w);
    if (v >= TWO256 >> 1n) v -= TWO256;
    const lim = 1n << BigInt(bits - 1);
    if (v < -lim || v >= lim) throw NOT_SURE;
    return v;
  }
  if (bt.startsWith('bytes') && bt.length > 5) {
    const n = Number(bt.slice(5));
    if (!Number.isInteger(n) || n < 1 || n > 32) throw NOT_SURE;
    return '0x' + word(st, pos).slice(0, 2 * n);
  }
  if (bt === 'bytes') {
    // Dynamic bytes at `pos`: length, then the data padded to 32 bytes.
    const n = index(st, pos);
    const padded = Math.ceil(n / 32) * 32;
    if (pos + 32 + padded > st.len) throw NOT_SURE;
    st.read += padded;
    if (st.read > st.len) throw NOT_SURE;
    return '0x' + st.hex.slice(2 + 2 * (pos + 32), 2 + 2 * (pos + 32 + n));
  }
  throw NOT_SURE; // string and anything else: let ethers do it
}
// A list of values laid out as a tuple starting at `base` (heads first,
// dynamic values behind pointers relative to `base`), exactly like ethers'
// unpack(). `keys` = the names ethers gives them.
function tuple(st: St, types: readonly ethers.ParamType[], keys: (string | null)[], base: number): ethers.Result {
  const values: unknown[] = [];
  let head = base;
  for (const t of types) {
    if (isDynamic(t)) {
      const off = index(st, head);
      head += 32;
      if (off % 32 !== 0 || base + off > st.len) throw NOT_SURE;
      values.push(value(st, t, base + off));
    } else {
      values.push(value(st, t, head));
      head += staticSize(t);
    }
  }
  return ethers.Result.fromItems(values, keys);
}
function value(st: St, t: ethers.ParamType, pos: number): unknown {
  if (t.baseType === 'tuple') {
    const comps = t.components!;
    return tuple(st, comps, comps.map((c) => c.name || null), pos);
  }
  if (t.baseType === 'array') {
    const child = t.arrayChildren!;
    let count = t.arrayLength;
    let base = pos;
    if (count === -1) {
      count = index(st, pos);
      // ethers' own check: at least 32 bytes per item left after this point.
      if (count * 32 > st.len - pos) throw NOT_SURE;
      base = pos + 32;
    }
    const types = new Array<ethers.ParamType>(count).fill(child);
    // ethers names every list item "_" (so a one-item list has the name "_").
    return tuple(st, types, new Array<string>(count).fill('_'), base);
  }
  return elementary(st, t, pos);
}

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
// True for "0x" + whole bytes of hex: exactly the text ethers.getBytes accepts.
export function isHexData(data: unknown): data is string { return typeof data === 'string' && HEX.test(data); }
// Fast read of `data` as `types`; null = not sure (use ethers).
export function liteDecode(types: ReadonlyArray<string | ethers.ParamType>, data: string | Uint8Array): ethers.Result | null {
  try {
    const pts = paramTypes(types);
    if (!pts) return null;
    let hex: string;
    if (typeof data === 'string') {
      if (!HEX.test(data)) return null;
      hex = data.toLowerCase();
    } else if (data instanceof Uint8Array) hex = '0x' + Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('hex');
    else return null;
    const st: St = { hex, len: (hex.length - 2) / 2, read: 0 };
    return tuple(st, pts, pts.map((p) => p.name || null), 0);
  } catch (e) {
    if (e === NOT_SURE) return null;
    return null; // anything unexpected: ethers decides
  }
}

// Drop-in for ethers.AbiCoder.defaultAbiCoder().decode(types, data): the
// fast reader when it is sure, ethers otherwise (same answer / same error).
export function abiDecode(types: ReadonlyArray<string | ethers.ParamType>, data: string | Uint8Array): ethers.Result {
  if (LITE_ON) {
    const r = liteDecode(types, data);
    if (r) return r;
  }
  return ethersCoder.decode(types as Array<string | ethers.ParamType>, data);
}
// A coder object with the same decode / encode calls as ethers' AbiCoder
// (encode is ethers' own), for files that hold `const coder = ...`.
export const liteCoder = {
  decode: (types: ReadonlyArray<string | ethers.ParamType>, data: ethers.BytesLike): ethers.Result => abiDecode(types, data as string | Uint8Array),
  encode: (types: ReadonlyArray<string | ethers.ParamType>, values: ReadonlyArray<unknown>): string => ethersCoder.encode(types as Array<string | ethers.ParamType>, values as unknown[]),
};

// ============================================================================
// FAST ENCODER for simple calls (feed speed, Oct 24)
//
// Plain English: looking up a new coin pair asks ~200 questions in one
// bundle (every exchange x every fee level). ethers builds each question
// with encodeFunctionData, which works out the function's 4-byte id again
// (a hash) and the checksum of every address (more hashes) on every call:
// ~20 ms per pair on the test machine, inside the feed trade that noticed
// the pair. Here the id is worked out once, addresses use the remembered
// checksum, and simple arguments (addresses, whole numbers, true/false,
// fixed bytes) are written straight into 32-byte slots. The text is exactly
// what ethers makes (tests compare). Anything else (other types, values
// ethers would refuse or convert) goes to ethers itself, so its answer or
// its error comes out unchanged. FEED_FAST_ABI=0 = always ethers.
// ============================================================================
type CallSpec = { selector: string; types: readonly ethers.ParamType[] } | null;
const callSpecs = new WeakMap<ethers.Interface, Map<string, CallSpec>>();
const SIMPLE = /^(address|bool|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|bytes([1-9]|[12][0-9]|3[0-2]))$/;
function callSpec(iface: ethers.Interface, name: string): CallSpec {
  let m = callSpecs.get(iface);
  if (!m) { m = new Map(); callSpecs.set(iface, m); }
  if (m.has(name)) return m.get(name)!;
  let spec: CallSpec = null;
  try {
    const fn = iface.getFunction(name);
    if (fn && fn.inputs.every((p) => SIMPLE.test(p.type))) spec = { selector: fn.selector.toLowerCase(), types: fn.inputs };
  } catch { spec = null; }
  if (m.size < 200) m.set(name, spec);
  return spec;
}
const ADDR = /^0x[0-9a-fA-F]{40}$/;
// One argument as a 32-byte slot (64 hex characters), or null = let ethers do it.
function slot(t: ethers.ParamType, v: unknown): string | null {
  const ty = t.type;
  if (ty === 'address') {
    if (typeof v !== 'string' || !ADDR.test(v)) return null;
    return '000000000000000000000000' + getAddressFast(v).slice(2).toLowerCase(); // getAddressFast throws like ethers on a bad checksum
  }
  if (ty === 'bool') return typeof v === 'boolean' ? (v ? ZERO64.slice(0, 63) + '1' : ZERO64) : null;
  if (ty.startsWith('bytes')) {
    const n = Number(ty.slice(5));
    if (typeof v !== 'string' || v.length !== 2 + 2 * n || !HEX.test(v)) return null;
    return v.slice(2).toLowerCase().padEnd(64, '0');
  }
  const signed = ty.startsWith('int');
  const bits = Number(ty.slice(signed ? 3 : 4) || 256);
  let x: bigint;
  if (typeof v === 'bigint') x = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) x = BigInt(v);
  else return null;
  if (signed) {
    const lim = 1n << BigInt(bits - 1);
    if (x < -lim || x >= lim) return null;   // ethers: out-of-bounds error
    if (x < 0n) x += TWO256;
  } else if (x < 0n || x >= (1n << BigInt(bits))) return null;
  return x.toString(16).padStart(64, '0');
}
// The encoded arguments (no id), or null = let ethers do it.
function slots(types: readonly ethers.ParamType[], values: ReadonlyArray<unknown>): string | null {
  if (!Array.isArray(values) || values.length !== types.length) return null;
  let out = '';
  for (let i = 0; i < types.length; i++) {
    const s = slot(types[i], values[i]);
    if (s === null) return null;
    out += s;
  }
  return out;
}
// Same text as iface.encodeFunctionData(name, values).
export function encodeCallFast(iface: ethers.Interface, name: string, values: ReadonlyArray<unknown> = []): string {
  if (LITE_ON) {
    const spec = callSpec(iface, name);
    if (spec) {
      const body = slots(spec.types, values);
      if (body !== null) return spec.selector + body;
    }
  }
  return iface.encodeFunctionData(name, values as unknown[]);
}
// Same text as AbiCoder.defaultAbiCoder().encode(types, values).
export function abiEncodeFast(types: readonly string[], values: ReadonlyArray<unknown>): string {
  if (LITE_ON && types.every((t) => SIMPLE.test(t))) {
    const pts = paramTypes(types);
    const body = pts ? slots(pts, values) : null;
    if (body !== null) return '0x' + body;
  }
  return ethersCoder.encode(types as string[], values as unknown[]);
}
