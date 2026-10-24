import { ethers } from 'ethers';

// ============================================================================
// LEAN NODE REQUESTS (freeze fix 2, Oct 24): same requests, same answers,
// far less throw-away memory.
//
// Plain English:
//   The bot asks the chain nodes thousands of questions a minute (prices,
//   blocks, the pool scan's bundled reads). Live, the bot made ~120 MB of
//   short-lived data a second and spent ~20 s of every 5 minutes cleaning it
//   up (GC), during which it can't react to a trade. A test-machine
//   allocation profile of the coin groups build showed ~90% of that memory
//   came from three spots inside ethers, not from the bot's own work:
//     1. the request text was turned into bytes one character at a time
//        into a plain list of numbers (ethers toUtf8Bytes),
//     2. the answer bytes were turned back into text the same way
//        (ethers toUtf8String), and
//     3. a bundled read's call data and answer (100+ KB of hex text) were
//        each re-checked byte by byte three times (ethers hexlify).
//   This file does the same three things with Node's own built-in
//   converters (Buffer / TextDecoder), which give the same bytes and text.
//
//   Exactly the same on the wire: same request bytes, same headers (the
//   content-type is set explicitly, as ethers does), same retry and timeout
//   rules (ethers' own FetchRequest still sends it). Anything unusual (an
//   answer that is not valid UTF-8 text, an odd call) goes through ethers'
//   own code, so even errors are the same. Tested against ethers with a
//   local fake node (src/test/freezeFix2.test.ts).
//
// Switches: RPC_LEAN=0 (requests / answers through ethers' converters, the
//   old way); RPC_LEAN_CALL=0 (bundled reads through provider.call again).
// ============================================================================

const leanOn = (): boolean => process.env.RPC_LEAN !== '0';
const leanCallOn = (): boolean => process.env.RPC_LEAN_CALL !== '0';

// Strict UTF-8 reader (refuses broken text, keeps a leading byte-order
// mark, like ethers). On any doubt ethers' own reader is used instead.
const DEC = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// The answer as JSON: Node's reader, or ethers' own if ours had any problem
// (then ethers gives its usual answer or its usual error).
function bodyJsonOf(response: ethers.FetchResponse): unknown {
  try {
    const b = response.body;
    if (b == null) return response.bodyJson;
    return JSON.parse(DEC.decode(b));
  } catch {
    return response.bodyJson;
  }
}

// ethers JsonRpcProvider._send, with the request bytes made by Buffer and
// the answer read by TextDecoder (see above). `old` = ethers' own _send.
export async function leanSend(
  p: ethers.JsonRpcProvider,
  payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[],
  old: () => Promise<Array<ethers.JsonRpcResult | ethers.JsonRpcError>>,
): Promise<Array<ethers.JsonRpcResult | ethers.JsonRpcError>> {
  if (!leanOn()) return old();
  const request = p._getConnection();
  // JSON.stringify never leaves half a character (it escapes them), so
  // Buffer's UTF-8 bytes are exactly ethers' bytes.
  request.body = Buffer.from(JSON.stringify(payload), 'utf8');
  request.setHeader('content-type', 'application/json');
  const response = await request.send();
  response.assertOk();
  let resp = bodyJsonOf(response) as Array<ethers.JsonRpcResult | ethers.JsonRpcError>;
  if (!Array.isArray(resp)) resp = [resp];
  return resp;
}

// Drop-in for ethers.JsonRpcProvider with the lean request / answer
// handling. Everything else (batching, retries, errors) is ethers' own.
export class LeanJsonRpcProvider extends ethers.JsonRpcProvider {
  override async _send(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]): Promise<Array<ethers.JsonRpcResult>> {
    return leanSend(this, payload, () => super._send(payload)) as Promise<Array<ethers.JsonRpcResult>>;
  }
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const LOWER_HEX_RE = /^0x(?:[0-9a-f]{2})*$/;

// A mixed-case address must carry a correct checksum (ethers refuses it
// otherwise, and provider.call must then give that same refusal).
const okAddr = new Set<string>();
function checksumOk(to: string): boolean {
  if (to === to.toLowerCase() || to.slice(2) === to.slice(2).toUpperCase() || okAddr.has(to)) return true;
  let ok = false;
  try { ok = ethers.getAddress(to) === to; } catch { ok = false; }
  if (ok) { if (okAddr.size > 1_000) okAddr.clear(); okAddr.add(to); }
  return ok;
}

// One plain eth_call at "latest", answer as hex text: exactly what
// provider.call({ to, data }) sends and returns, without ethers re-checking
// the (often 100+ KB) call data and answer byte by byte three times.
//   Same request: provider.call sends { to (lowercase), data (lowercase) }
//   and "latest" (ethers getRpcTransaction); errors come from the same
//   ethers code (a reverted call is still CALL_EXCEPTION).
//   Used only where it is provably the same: an ethers JSON-RPC provider
//   with a fixed network (otherwise provider.call also asks the chain id)
//   and no request-rate limit of ethers' own; plain address and hex data.
//   Anything else: provider.call, as before.
export async function ethCall(provider: unknown, to: string, data: string): Promise<string> {
  const p = provider as ethers.JsonRpcApiProvider & { call: (tx: { to: string; data: string }) => Promise<string> };
  const lean = leanCallOn() && provider instanceof ethers.JsonRpcApiProvider
    && !!p._getOption('staticNetwork') && (p as unknown as { _requestRate: number | null })._requestRate == null
    && typeof to === 'string' && ADDR_RE.test(to) && checksumOk(to) && typeof data === 'string' && HEX_RE.test(data);
  if (!lean) return p.call({ to, data });
  const r: unknown = await p.send('eth_call', [{ to: to.toLowerCase(), data: data.toLowerCase() }, 'latest']);
  // ethers returns hexlify(answer): lowercase hex. Already lowercase hex =
  // unchanged; anything else goes through hexlify (same value or same error).
  return typeof r === 'string' && LOWER_HEX_RE.test(r) ? r : ethers.hexlify(r as ethers.BytesLike);
}
