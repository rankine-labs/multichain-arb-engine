// ============================================================================
// SIM-COMPARE step 2a: the NODE's answer (the truth we compare against).
//
// Plain English:
//   Each check is sent to the node exactly the way the bot sends it:
//   - follow-a-trade: through the bot's own replayRpc, i.e. eth_simulateV1 on
//     the block before, replaying that block's trades up to and including
//     the one we follow, then our trade (same block time, same huge gas limit)
//   - standing gap: a plain eth_call on the state at the start of the block
//   The request body (calldata, pretend balances, contract code) is the one
//   captured from the bot's simulateRoundTrip in step 1, so it is identical.
//
//   Answers are saved to node.jsonl as soon as they arrive; a rerun (or
//   --resume after Ctrl-C) never asks the node the same check twice.
//   "Slow down" / network trouble is NOT saved (tried again next run); a node
//   that can't serve the check (old state gone, replay unavailable) IS saved
//   as node_error and left out of the match rate (counted separately).
// ============================================================================
import { join } from 'path';
import { Rpc, replayRpc, readReplayAnswer, extractRevertData, isRateLimited, ReplayCall } from '../../src/execution/simulator';
import { BlockPrefix, Case, NodeRecord, RawAnswer } from './types';
import { unpackOverrides } from './collect';
import { appendJsonl, hex, readJson } from './util';

// Same wording the bot uses for "the node can't serve that old state".
export const STATE_GONE_RE = /missing trie node|historical state|state.*(not available|unavailable)|header not found|unknown block|pruned/i;

// Answers that are about the node, not about our trade.
export function isNodeTrouble(err: { code?: number; message?: string } | undefined): string | null {
  if (!err) return null;
  const m = String(err.message ?? '');
  if (isRateLimited(err) || m.startsWith('network:') || /cap reached/.test(m)) return 'busy';
  if (STATE_GONE_RE.test(m)) return 'state gone';
  if (err.code === -32601 || /method not found|not supported|does not exist/i.test(m)) return 'method missing';
  if (err.code === -32602 || /invalid (params|argument)/i.test(m)) return 'invalid params';
  if (/timeout|timed out|deadline/i.test(m)) return 'timeout';
  return null;
}

// The replayed trades of the block (from step 1), as the bot's replayRpc wants them.
export function prefixFor(c: Case, out: string): ReplayCall[] | null {
  if (c.mode !== 'trigger') return [];
  const b = readJson<BlockPrefix>(join(out, 'blocks', `${c.block}.json`));
  if (!b) return null;
  const calls = b.calls.filter((x) => x.i <= (c.txIndex ?? -1));
  if (calls.length !== c.prefixLen || calls[calls.length - 1]?.hash !== c.triggerHash) return null;
  return calls.map(({ from, to, data, value, gas }) => ({ from, to, data, ...(value !== undefined ? { value } : {}), ...(gas !== undefined ? { gas } : {}) }));
}

// Our call's raw answer out of an eth_simulateV1 result (last call = ours).
export function rawFromSimulate(result: any): { raw: RawAnswer; prefixStatuses: string } | null {
  const block = Array.isArray(result) ? result[0] : result;
  const calls: any[] = Array.isArray(block?.calls) ? block.calls : [];
  if (!calls.length) return null;
  const ours = calls[calls.length - 1];
  const okOf = (x: any) => {
    const st = x?.status;
    const err = typeof x?.error === 'string' ? { message: x.error } : x?.error;
    return !(st === '0x0' || st === 0 || st === false || st === '0' || (st === undefined && !!err));
  };
  const err = typeof ours?.error === 'string' ? { message: ours.error } : ours?.error;
  const success = okOf(ours);
  let output = '0x';
  if (success) output = typeof ours?.returnData === 'string' ? ours.returnData : '0x';
  else {
    const fromErr = err ? extractRevertData(err) : null;
    output = fromErr && fromErr !== '0x' ? fromErr : typeof ours?.returnData === 'string' ? ours.returnData : '0x';
  }
  let gasUsed: string | null = null;
  try { if (ours?.gasUsed !== undefined && ours.gasUsed !== null) gasUsed = BigInt(ours.gasUsed).toString(); } catch { /* none */ }
  return {
    raw: { success, output: output.toLowerCase(), gasUsed, ...(!success && err?.message ? { message: String(err.message).slice(0, 200) } : {}) },
    prefixStatuses: calls.slice(0, -1).map((x) => (okOf(x) ? '1' : '0')).join(''),
  };
}

// Ask the node one check. Returns null when the node was busy (try later).
export async function nodeAnswer(rpc: Rpc, c: Case, out: string): Promise<NodeRecord | null> {
  const t0 = Date.now();
  const overrides = unpackOverrides(c);
  if (c.mode === 'trigger') {
    const prefix = prefixFor(c, out);
    if (!prefix) return { id: c.id, status: 'node_error', reason: 'block data missing (collect again)', via: 'eth_simulateV1', ms: 0 };
    // Record the raw eth_simulateV1 answer on its way through the bot's replayRpc.
    let seen: { result?: any; error?: any } | null = null;
    const recording: Rpc = async (m, p) => { const r = await rpc(m, p); if (m === 'eth_simulateV1') seen = r; return r; };
    const replay = replayRpc(recording, hex(c.parent), prefix, c.time ?? undefined);
    const shaped = await replay('eth_call', [c.call, c.tag, overrides]);
    const ms = Date.now() - t0;
    const s = seen as { result?: any; error?: any } | null;
    if (!s) return null;
    if (s.error) {
      const why = isNodeTrouble(s.error);
      if (why === 'busy') return null;
      return { id: c.id, status: 'node_error', reason: `replay unavailable: ${why ?? String(s.error.message ?? '').slice(0, 100)}`, via: 'eth_simulateV1', ms };
    }
    // The bot's own reader decides whether the answer is usable (right number of calls).
    const check = readReplayAnswer(s.result, prefix.length + 1);
    if (check.error && /^replay unavailable/.test(String(check.error.message))) {
      return { id: c.id, status: 'node_error', reason: String(check.error.message), via: 'eth_simulateV1', ms };
    }
    void shaped;
    const got = rawFromSimulate(s.result);
    if (!got) return { id: c.id, status: 'node_error', reason: 'replay unavailable (no answer)', via: 'eth_simulateV1', ms };
    return { id: c.id, status: 'answer', raw: got.raw, via: 'eth_simulateV1', prefixStatuses: got.prefixStatuses, ms };
  }
  // Standing gap: plain eth_call at the start of the block (= end of the parent).
  const r = await rpc('eth_call', [c.call, hex(c.parent), overrides]);
  const ms = Date.now() - t0;
  if (!r.error) return { id: c.id, status: 'answer', raw: { success: true, output: String(r.result ?? '0x').toLowerCase(), gasUsed: null }, via: 'eth_call', ms };
  const why = isNodeTrouble(r.error);
  if (why === 'busy') return null;
  const data = extractRevertData(r.error);
  if (why && (!data || data === '0x')) return { id: c.id, status: 'node_error', reason: `eth_call: ${why}`, via: 'eth_call', ms };
  return { id: c.id, status: 'answer', raw: { success: false, output: (data ?? '0x').toLowerCase(), gasUsed: null, message: String(r.error.message ?? '').slice(0, 200) }, via: 'eth_call', ms };
}

export function saveNodeRecord(out: string, rec: NodeRecord): void { appendJsonl(join(out, 'node.jsonl'), rec); }
