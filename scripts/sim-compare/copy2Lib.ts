// ============================================================================
// COPY 2 CHECKER: the parts with no network (used by copy2-dryrun.ts, tested
// offline in test/copy2.test.ts).
//
// Plain English:
//   "Copy 2" is arbsim's copy of OUR pools, kept current from the pools' own
//   reports ("logs": swaps, mints, burns, syncs, coin transfers). The dry run
//   (copy2-dryrun.ts) feeds a TEST arbsim those reports and keeps asking it
//   and the node the same questions. Everything here is plain bookkeeping:
//     1. which pools to follow, and what kind each one is ("track" list)
//     2. which reports to subscribe to (pool logs + coin Transfers to/from
//        our pools)
//     3. putting the reports of one block together, in order, and deciding
//        when a block is complete (BlockAssembler)
//     4. reading arbsim's status (which pools are ready / unsure)
//     5. the "probe" questions per pool kind (price, liquidity, coin balances)
//     6. turning arbsim and node answers into the same shape the bot's own
//        check code (simulateRoundTrip) reads
//     7. comparing answers, keeping score, and writing the plain-English
//        summary
//
// Message shapes follow sim/COPY2_PLAN.md ("Shape"). Kind names are the
// plan's PoolKind names in lower case (v2, solidly, v3, pancakev3, algebra,
// v4). If workstream A's real protocol differs, change it HERE only.
// ============================================================================
import { ethers } from 'ethers';
import { PoolState } from '../../src/core/types';
import { kindForPool, KIND_SOLIDLY, KIND_V2, KIND_V3, KIND_V4, COPY_V3_CALLBACK } from '../../src/execution/executorCalldata';
import { SimResult } from '../../src/execution/simulator';
import { hex, lc, median, pct, rng } from './util';

export const RH_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)').toLowerCase();

// ---------------------------------------------------------------------------
// 1. Which pools, and what kind (the `track` list)
// ---------------------------------------------------------------------------
export type Copy2Kind = 'v2' | 'solidly' | 'v3' | 'pancakev3' | 'algebra' | 'v4';

// One entry of the `track` message (plan: {address, v4Id?, kind, token0,
// token1, fee, tickSpacing}). For V4, `address` is the PoolManager and
// `v4Id` the 32-byte pool id. token0/token1 are in the POOL's own order.
export interface TrackEntry { address: string; v4Id?: string; kind: Copy2Kind; token0: string; token1: string; fee: number; tickSpacing: number }

// Copy 2's kind for one watched pool, or null + why when copy 2 can't follow it.
// Uniswap V3 "copies" under other names (forks) are followed as v3 unless
// onlyProven is set: copy 2 re-runs the pool's own code, so a fork usually
// works, and the dry run is exactly where we find out.
export function copy2KindOf(p: PoolState, onlyProven = false): { kind: Copy2Kind } | { why: string } {
  const k = kindForPool(p);
  const dex = lc(p.dex);
  if (k === null) return { why: `our contract can't trade ${p.dex}` };
  if (k === KIND_V4) return { kind: 'v4' };
  if (p.v4) return { why: 'hooked V4 pool (copy 2 follows hook-free V4 only)' };
  if (p.variant === 'algebra') return { kind: 'algebra' };
  if (k === KIND_V2) return { kind: 'v2' };
  if (k === KIND_SOLIDLY) return { kind: 'solidly' };
  if (k === KIND_V3) {
    if (dex === 'pancakeswap-v3' || COPY_V3_CALLBACK[dex] === 'pancakeV3SwapCallback') return { kind: 'pancakev3' };
    if (dex === 'uniswap-v3') return { kind: 'v3' };
    return onlyProven ? { why: `${p.dex}: V3 fork, not proven offline` } : { kind: 'v3' };
  }
  return { why: `kind ${k} not followed by copy 2` };
}

// The pool's two coins in its own order. V2/V3: sorted addresses. V4:
// currency0 = tokenA (native ETH = address 0 when the pool is native).
export function poolCoins(p: PoolState, weth: string): { token0: string; token1: string } {
  if (p.v4) {
    const n = (t: string) => (p.v4!.native && lc(t) === lc(weth) ? ZERO : lc(t));
    return { token0: n(p.tokenA), token1: n(p.tokenB) };
  }
  const [token0, token1] = [lc(p.tokenA), lc(p.tokenB)].sort();
  return { token0: token0!, token1: token1! };
}

// The key a pool is known by everywhere in the dry run: the pool address,
// or the 32-byte id for V4 (both lower case).
export const poolKey = (p: PoolState) => lc(p.poolAddress);

export interface Followed { pools: Map<string, { pool: PoolState; track: TrackEntry }>; notFollowed: Record<string, number> }

// Pools we trade = watched Robinhood pools whose coin pair is on 2+
// exchanges (same rule as liveReaction / liveLatency), minus what copy 2
// can't follow (counted by reason).
export function followedPools(list: PoolState[], weth: string, onlyProven = false): Followed {
  const all = list.filter((p) => p && p.chain === 'robinhood' && p.poolAddress && p.tokenA && p.tokenB);
  const byPair = new Map<string, PoolState[]>();
  for (const p of all) { const k = [lc(p.tokenA), lc(p.tokenB)].sort().join('/'); (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p); }
  const pools = new Map<string, { pool: PoolState; track: TrackEntry }>();
  const notFollowed: Record<string, number> = {};
  for (const group of byPair.values()) {
    if (new Set(group.map((p) => p.dex)).size < 2) continue;
    for (const p of group) {
      const key = poolKey(p);
      if (pools.has(key)) continue;
      const k = copy2KindOf(p, onlyProven);
      if ('why' in k) { notFollowed[k.why] = (notFollowed[k.why] ?? 0) + 1; continue; }
      const { token0, token1 } = poolCoins(p, weth);
      const isV4 = key.length === 66;
      const track: TrackEntry = {
        address: isV4 ? lc(p.v4?.poolManager ?? RH_POOL_MANAGER) : key,
        ...(isV4 ? { v4Id: key } : {}),
        kind: k.kind, token0, token1,
        // Plan (copy2/mod.rs TrackedPool): fee + tick spacing are V4 key
        // details, 0 for other kinds (their own code knows its fee).
        fee: p.v4?.fee ?? 0,
        tickSpacing: p.v4?.tickSpacing ?? 0,
      };
      pools.set(key, { pool: p, track });
    }
  }
  return { pools, notFollowed };
}

// ---------------------------------------------------------------------------
// 2. What to subscribe to (Chainstack eth_subscribe "logs" filters)
// ---------------------------------------------------------------------------
export const padTopic = (addr: string) => '0x' + '0'.repeat(24) + lc(addr).slice(2);

// Same chunk sizes as liveReaction (200 addresses / 100 V4 ids / 100 topics).
export function logFilters(f: Followed): Array<Record<string, unknown>> {
  const addrs = [...f.pools.keys()].filter((k) => k.length === 42);
  const ids = [...f.pools.keys()].filter((k) => k.length === 66);
  const managers = [...new Set([...f.pools.values()].filter((x) => x.track.v4Id).map((x) => x.track.address))];
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < addrs.length; i += 200) out.push({ address: addrs.slice(i, i + 200) });
  for (const pm of managers) {
    const mine = ids.filter((id) => f.pools.get(id)!.track.address === pm);
    for (let i = 0; i < mine.length; i += 100) out.push({ address: pm, topics: [null, mine.slice(i, i + 100)] });
  }
  // Coin Transfers TO our pools (topic 2) and FROM our pools (topic 1).
  // V4 pools have no balances of their own (the PoolManager holds them all).
  const padded = addrs.map(padTopic);
  for (let i = 0; i < padded.length; i += 100) {
    out.push({ topics: [TRANSFER_TOPIC, null, padded.slice(i, i + 100)] });
    out.push({ topics: [TRANSFER_TOPIC, padded.slice(i, i + 100)] });
  }
  return out;
}

// What one incoming log is to us:
//   'pool'     a report from one of our pools (or the PoolManager for our V4 ids)
//   'transfer' a coin transfer to/from one of our pools, of one of ITS two coins
//   null       something else (ignored; counted)
export function classifyLog(log: any, f: Followed): 'pool' | 'transfer' | null {
  const a = lc(log?.address ?? '');
  const t0 = lc(log?.topics?.[0] ?? '');
  if (t0 === TRANSFER_TOPIC && Array.isArray(log.topics) && log.topics.length === 3) {
    const from = '0x' + lc(log.topics[1]).slice(26), to = '0x' + lc(log.topics[2]).slice(26);
    for (const side of [from, to]) {
      const p = f.pools.get(side);
      if (p && !p.track.v4Id && (a === p.track.token0 || a === p.track.token1)) return 'transfer';
    }
    // A Transfer of the pool's OWN LP token is a pool report (V2 pairs).
    if (f.pools.has(a)) return 'pool';
    return null;
  }
  if (f.pools.has(a) && a.length === 42) return 'pool';
  const id = lc(log?.topics?.[1] ?? '');
  const v = f.pools.get(id);
  if (v && v.track.v4Id && v.track.address === a) return 'pool';
  return null;
}

// ---------------------------------------------------------------------------
// 3. One message per block, in block order
// ---------------------------------------------------------------------------
// Plain English: reports arrive one by one, from several subscriptions. A
// block is sent to arbsim (as one `pool_logs`) once we're confident all its
// reports are in:
//   - its header has arrived and `graceMs` has passed since (the node sends a
//     block's reports before its header, the grace covers the rest), or
//   - something from 2+ blocks later has arrived, or
//   - no header came at all and `maxWaitMs` passed since its first report.
// Blocks always go out in increasing order. A report for a block that has
// already been sent is "late": it is still sent (as its own message, so
// arbsim can mark that pool unsure) and counted.
export interface Head { block: number; timestamp: number | null; l1Block: number | null; at: number }
export interface BlockOut { block: number; timestamp: number | null; l1Block: number | null; logs: any[]; firstLogAt: number | null; headAt: number | null; late?: boolean }

const num = (v: unknown): number | null => { if (v === undefined || v === null || v === '') return null; try { return Number(BigInt(v as string)); } catch { return null; } };
export const logOrder = (a: any, b: any) => (num(a.transactionIndex) ?? 0) - (num(b.transactionIndex) ?? 0) || (num(a.logIndex) ?? 0) - (num(b.logIndex) ?? 0);

// How long a block whose reports arrived without its header waits for the
// header before it is sent anyway (header then read from the node).
export const HEADERLESS_WAIT_MS = 400;

export class BlockAssembler {
  private logs = new Map<number, any[]>();
  private firstAt = new Map<number, number>();
  private heads = new Map<number, Head>();
  private sentHeads = new Map<number, Head>(); // headers of the last 256 blocks sent (for late reports)
  private newest = 0;
  lastSent = 0;   // highest block already sent (0 = nothing yet)
  late = 0;       // reports that arrived after their block was sent
  noHeader = 0;   // blocks sent without a header (timestamp unknown)
  constructor(private readonly graceMs = 30, private readonly maxWaitMs = 1500) {}

  // Returns a ready "late" message when the block was already sent.
  addLog(log: any, now: number): BlockOut | null {
    const b = num(log?.blockNumber);
    if (b === null) return null;
    if (this.lastSent && b <= this.lastSent) {
      this.late++;
      // The header was already used and forgotten: take the block time we
      // remembered when the block went out (arbsim needs it on every message).
      const h = this.heads.get(b) ?? this.sentHeads.get(b);
      return { block: b, timestamp: h?.timestamp ?? null, l1Block: h?.l1Block ?? null, logs: [log], firstLogAt: now, headAt: h?.at ?? null, late: true };
    }
    (this.logs.get(b) ?? this.logs.set(b, []).get(b)!).push(log);
    if (!this.firstAt.has(b)) this.firstAt.set(b, now);
    if (b > this.newest) this.newest = b;
    return null;
  }

  addHead(h: Head): void {
    if (h.block > this.lastHead) this.lastHead = h.block;
    if (this.lastSent && h.block <= this.lastSent) return;
    if (!this.heads.has(h.block)) this.heads.set(h.block, h);
    if (h.block > this.newest) this.newest = h.block;
  }

  // Blocks ready to send now, oldest first. Blocks with a header but no
  // reports come out with logs = [] (sent as `block_tick`).
  due(now: number): BlockOut[] {
    const pending = [...new Set([...this.logs.keys(), ...this.heads.keys()])].filter((b) => b > this.lastSent).sort((a, b) => a - b);
    let upto = -1;
    for (const b of pending) {
      const h = this.heads.get(b);
      const first = this.firstAt.get(b);
      // A block needs its header (block time) before it can go out: arbsim
      // refuses block messages without a timestamp. So a block whose reports
      // came in before its header waits for the header (normally a few ms),
      // and only after HEADERLESS_WAIT_MS is it sent anyway; the caller then
      // reads the header from the node first (see copy2-dryrun pump()).
      const ready = h
        ? now - h.at >= this.graceMs || this.newest >= b + 2
        : first !== undefined && ((now - first >= Math.min(this.maxWaitMs, HEADERLESS_WAIT_MS) && this.newest >= b + 1) || now - first >= this.maxWaitMs);
      if (ready) upto = b; // everything older is sent with it (order kept)
    }
    const out: BlockOut[] = [];
    for (const b of pending) {
      if (b > upto) break;
      const h = this.heads.get(b);
      const logs = (this.logs.get(b) ?? []).sort(logOrder);
      if (!h && logs.length) this.noHeader++;
      out.push({ block: b, timestamp: h?.timestamp ?? null, l1Block: h?.l1Block ?? null, logs, firstLogAt: this.firstAt.get(b) ?? null, headAt: h?.at ?? null });
      if (h) { this.sentHeads.set(b, h); if (this.sentHeads.size > 256) this.sentHeads.delete(this.sentHeads.keys().next().value!); }
      this.logs.delete(b); this.firstAt.delete(b); this.heads.delete(b);
      this.lastSent = b;
    }
    return out;
  }

  // Blocks missed between the newest header seen so far and a newly seen
  // header (e.g. after a reconnect): [from, to] to read back from the node,
  // or null. Call BEFORE addHead for that header.
  gapBefore(block: number): { from: number; to: number } | null {
    const last = Math.max(this.lastHead, this.lastSent);
    if (!last || block <= last + 1) return null;
    return { from: last + 1, to: block - 1 };
  }
  private lastHead = 0;
}

// The messages for one finished block (plan shapes).
export function blockMessage(b: BlockOut): Record<string, unknown> {
  if (!b.logs.length) return { type: 'block_tick', block: b.block, timestamp: b.timestamp, ...(b.l1Block !== null ? { l1Block: b.l1Block } : {}) };
  return { type: 'pool_logs', block: b.block, timestamp: b.timestamp, ...(b.l1Block !== null ? { l1Block: b.l1Block } : {}), logs: b.logs };
}

export function headFromNewHeads(r: any, now: number): Head | null {
  const block = num(r?.number);
  if (block === null) return null;
  return { block, timestamp: num(r.timestamp), l1Block: num(r.l1BlockNumber), at: now };
}

// ---------------------------------------------------------------------------
// 4. arbsim's status: which pools are ready / unsure / loading
// ---------------------------------------------------------------------------
// The plan says status carries per-pool state (loading / ready / unsure) and
// counters; the exact field names come from workstream A. Several likely
// shapes are understood; anything else = "not reported" (null).
export interface Copy2Status {
  block: number | null;                     // newest block the copy has applied
  ready: Set<string> | null;                // pool keys (address / V4 id), null = not reported
  unsure: Set<string> | null;
  loading: Set<string> | null;
  counts: { ready: number | null; unsure: number | null; loading: number | null; tracked: number | null };
  eventsApplied: number | null;
  nodeUsedToday: number | null;             // arbsim's paid-node requests today (its own allowance file)
  publicUsedToday: number | null;           // arbsim's reads on the free public node
}

export function readCopy2Status(s: any): Copy2Status {
  const c = s?.copy2 ?? s?.poolEvents ?? s ?? {};
  const n = (...vs: unknown[]) => { for (const v of vs) { const x = typeof v === 'number' ? v : num(v); if (x !== null && Number.isFinite(x)) return x; } return null; };
  const block = n(c.lastBlock, c.block, c.head?.block, c.headBlock, c.appliedBlock, c.copyBlock, s?.copy2Block);
  let ready: Set<string> | null = null, unsure: Set<string> | null = null, loading: Set<string> | null = null;
  const put = (key: string, state: string) => {
    const st = lc(state);
    const k = lc(key);
    if (st === 'ready') (ready ??= new Set()).add(k);
    else if (st === 'unsure') (unsure ??= new Set()).add(k);
    else if (st === 'loading') (loading ??= new Set()).add(k);
  };
  const keyOf = (e: any) => e?.v4Id ?? e?.v4_id ?? e?.id ?? e?.pool ?? e?.address;
  // arbsim (copy2/intake.rs status_json): `pools` is a COUNT; the per-pool
  // list is `list` (only when asked with {pools:true}).
  const pools = Array.isArray(c.list) ? c.list : typeof c.pools === 'number' ? undefined : c.pools ?? c.perPool;
  if (Array.isArray(pools)) {
    for (const e of pools) { const k = keyOf(e); const st = e?.state ?? e?.status; if (typeof k === 'string' && typeof st === 'string') put(k, st); }
  } else if (pools && typeof pools === 'object') {
    for (const [k, v] of Object.entries(pools)) { const st = typeof v === 'string' ? v : (v as any)?.state ?? (v as any)?.status; if (typeof st === 'string') put(k, st); }
  }
  for (const [field, st] of [['readyPools', 'ready'], ['unsurePools', 'unsure'], ['loadingPools', 'loading']] as const) {
    if (Array.isArray(c[field])) for (const k of c[field]) if (typeof k === 'string') put(k, st);
  }
  // A reported list with nothing in it means "none", not "not reported".
  if (pools !== undefined || Array.isArray(c.readyPools)) { ready ??= new Set(); unsure ??= new Set(); loading ??= new Set(); }
  const r = ready as Set<string> | null, u = unsure as Set<string> | null, l = loading as Set<string> | null;
  return {
    block, ready: r, unsure: u, loading: l,
    counts: {
      ready: n(typeof c.ready === 'number' ? c.ready : null, c.readyCount, c.counts?.ready, r?.size),
      unsure: n(typeof c.unsure === 'number' ? c.unsure : null, c.unsureCount, c.counts?.unsure, u?.size),
      loading: n(typeof c.loading === 'number' ? c.loading : null, c.loadingCount, c.counts?.loading, l?.size),
      tracked: n(c.tracked, c.trackedCount, c.counts?.tracked),
    },
    eventsApplied: n(c.eventsApplied, c.events_applied, c.applied),
    nodeUsedToday: n(s?.node?.usedToday),
    publicUsedToday: n(s?.node?.public?.usedToday),
  };
}

// ---------------------------------------------------------------------------
// 5. Probe questions per pool kind (read with the pool's own read functions)
// ---------------------------------------------------------------------------
// Plain English: "key storage" of a pool = its price, liquidity and the two
// coin balances it holds. We read them the way anyone would (the pool's own
// read functions, the coins' balanceOf), on BOTH sides, at the same block,
// so the answers must be byte-identical. V4 pools live inside the
// PoolManager: there we read the pool's own storage slots directly
// (extsload: slot0 and liquidity of pools[id], StateLibrary layout).
const IFACE = new ethers.Interface([
  'function getReserves() view returns (uint112,uint112,uint32)', 'function slot0()', 'function liquidity() view returns (uint128)',
  'function globalState()', 'function balanceOf(address) view returns (uint256)', 'function extsload(bytes32) view returns (bytes32)',
]);
export const V4_POOLS_SLOT = 6n;
export const PROBE_FROM = '0x0000000000000000000000000000000000000b07';

export interface ProbeCall { label: string; to: string; data: string }

export function v4StateSlot(id: string): string { return ethers.keccak256(ethers.concat([id, ethers.zeroPadValue(ethers.toBeHex(V4_POOLS_SLOT), 32)])).toLowerCase(); }

export function probeCalls(t: TrackEntry): ProbeCall[] {
  const enc = (fn: string, args: unknown[] = []) => IFACE.encodeFunctionData(fn, args);
  if (t.kind === 'v4') {
    const base = BigInt(v4StateSlot(t.v4Id!));
    return [
      { label: 'v4 slot0', to: t.address, data: enc('extsload', [ethers.toBeHex(base, 32)]) },
      { label: 'v4 liquidity', to: t.address, data: enc('extsload', [ethers.toBeHex(base + 3n, 32)]) },
    ];
  }
  const out: ProbeCall[] = [];
  if (t.kind === 'v2' || t.kind === 'solidly') out.push({ label: 'getReserves', to: t.address, data: enc('getReserves') });
  else if (t.kind === 'algebra') out.push({ label: 'globalState', to: t.address, data: enc('globalState') }, { label: 'liquidity', to: t.address, data: enc('liquidity') });
  else out.push({ label: 'slot0', to: t.address, data: enc('slot0') }, { label: 'liquidity', to: t.address, data: enc('liquidity') });
  for (const [i, coin] of [t.token0, t.token1].entries()) if (coin !== ZERO) out.push({ label: `coin${i} balance`, to: coin, data: enc('balanceOf', [t.address]) });
  return out;
}

export interface RawAnswer { success: boolean; output: string; gasUsed: string | null }
export type FastOutcome = { kind: 'answer'; results: RawAnswer[]; atBlock: number | null } | { kind: 'unknown'; why: string };

// arbsim `call` answer -> per-call answers, or why it couldn't answer.
export function readFastAnswer(ans: any, expected: number): FastOutcome {
  if (!ans || ans.ok !== true) {
    const why = ans?.unknown ? String(ans.unknown) : ans?.timeout ? 'timeout' : `error: ${String(ans?.error ?? 'bad answer').slice(0, 100)}`;
    return { kind: 'unknown', why };
  }
  const rs: any[] = Array.isArray(ans.results) ? ans.results : [];
  if (rs.length !== expected) return { kind: 'unknown', why: `${rs.length} answers for ${expected} calls` };
  const g = (v: unknown) => { try { return v === undefined || v === null ? null : BigInt(v as string).toString(); } catch { return null; } };
  return { kind: 'answer', atBlock: num(ans.at?.block), results: rs.map((r) => ({ success: r?.success === true, output: lc(String(r?.output ?? '0x')), gasUsed: g(r?.gasUsed) })) };
}

// Node eth_call answer -> RawAnswer (a revert is an answer too), or null = node trouble.
export function rawFromEthCall(r: { result?: any; error?: { message?: string; data?: any } }): RawAnswer | null {
  if (!r.error) return { success: true, output: lc(String(r.result ?? '0x')), gasUsed: null };
  const m = String(r.error.message ?? '');
  const data = typeof r.error.data === 'string' ? r.error.data : typeof r.error.data?.data === 'string' ? r.error.data.data : null;
  if (/revert/i.test(m) || data) return { success: false, output: lc(data ?? '0x'), gasUsed: null };
  return null;
}

export type ProbeVerdict = 'same' | 'different' | 'fast-unsure' | 'fast-missing' | 'node-trouble';

// One pool's probe: every call must be byte-identical on both sides.
export function compareProbe(fast: FastOutcome, node: Array<RawAnswer | null>): { verdict: ProbeVerdict; diffs: string[] } {
  if (node.some((n) => n === null)) return { verdict: 'node-trouble', diffs: [] };
  if (fast.kind === 'unknown') return { verdict: /unsure/i.test(fast.why) ? 'fast-unsure' : 'fast-missing', diffs: [fast.why] };
  const diffs: string[] = [];
  node.forEach((n, i) => {
    const f = fast.results[i]!;
    if (f.success !== n!.success || f.output !== n!.output) diffs.push(`call ${i}: fast ${f.success ? 'ok' : 'revert'} ${f.output.slice(0, 74)} vs node ${n!.success ? 'ok' : 'revert'} ${n!.output.slice(0, 74)}`);
  });
  return { verdict: diffs.length ? 'different' : 'same', diffs };
}

// ---------------------------------------------------------------------------
// 6. Answers in the shape the bot's check code reads
// ---------------------------------------------------------------------------
// simulateRoundTrip sends ONE eth_call to our (pretend) contract. These turn
// arbsim's answer and the node's callTracer answer into exactly what an
// eth_call would have returned, so the bot's own code reads both.
export const FAST_UNKNOWN_PREFIX = 'local sim unknown: ';

export function rpcFromFast(o: FastOutcome): { result?: any; error?: { message?: string; data?: any; gasUsed?: string } } {
  if (o.kind === 'unknown') return { error: { message: FAST_UNKNOWN_PREFIX + o.why } };
  const r = o.results[o.results.length - 1]!;
  if (r.success) return { result: r.output };
  return { error: { message: 'execution reverted', data: r.output, ...(r.gasUsed ? { gasUsed: r.gasUsed } : {}) } };
}

// debug_traceCall (callTracer) result -> eth_call-shaped answer + raw.
export function rpcFromTrace(t: any): { rpc: { result?: any; error?: { message?: string; data?: any; gasUsed?: string } }; raw: RawAnswer } {
  const g = (() => { try { return t?.gasUsed !== undefined ? BigInt(t.gasUsed).toString() : null; } catch { return null; } })();
  const output = lc(String(t?.output ?? '0x'));
  if (!t?.error) return { rpc: { result: output }, raw: { success: true, output, gasUsed: g } };
  return { rpc: { error: { message: `execution reverted${typeof t.error === 'string' && t.error !== 'execution reverted' ? ': ' + t.error : ''}`, data: output, ...(g ? { gasUsed: g } : {}) } }, raw: { success: false, output, gasUsed: g } };
}

// ---------------------------------------------------------------------------
// 7. Comparing real checks, keeping score, the summary
// ---------------------------------------------------------------------------
export type CheckVerdict = 'exact' | 'same-verdict' | 'different' | 'fast-unsure' | 'fast-missing' | 'node-trouble';
export interface CheckCompare { verdict: CheckVerdict; wrong: boolean; missed: boolean; profitDiff: string | null; gasDiff: number | null; fastStatus: string; nodeStatus: string }

const NODE_TROUBLE = new Set(['rate_limited', 'unsupported']);

// fastRaw/nodeRaw: our call's raw answers (null = not available).
// "wrong" = the fast side said PROFIT and the node said no profit: the
// dangerous mistake (the bot would send a losing trade).
// "missed" = the node said profit, the fast side (answering) said no.
export function compareCheck(fast: SimResult, node: SimResult, fastRaw: RawAnswer | null, nodeRaw: RawAnswer | null, fastUnknown: string | null): CheckCompare {
  const profitOf = (r: SimResult) => (r.status === 'profit' ? r.profit : null);
  const base = { fastStatus: fast.status, nodeStatus: node.status };
  if (NODE_TROUBLE.has(node.status) || (node.status === 'fail' && /^network|replay unavailable|header not found|missing trie/i.test(node.reason))) {
    return { verdict: 'node-trouble', wrong: false, missed: false, profitDiff: null, gasDiff: null, ...base };
  }
  if (fastUnknown !== null) return { verdict: /unsure/i.test(fastUnknown) ? 'fast-unsure' : 'fast-missing', wrong: false, missed: false, profitDiff: null, gasDiff: null, ...base };
  const fp = profitOf(fast), np = profitOf(node);
  const wrong = fp !== null && np === null;
  const missed = np !== null && fp === null;
  const profitDiff = fp !== null && np !== null ? (fp - np).toString() : null;
  const gasDiff = fastRaw?.gasUsed && nodeRaw?.gasUsed ? Number(BigInt(fastRaw.gasUsed) - BigInt(nodeRaw.gasUsed)) : null;
  const exact = !!fastRaw && !!nodeRaw && fastRaw.success === nodeRaw.success && fastRaw.output === nodeRaw.output;
  const sameVerdict = fast.status === node.status && (fp === null || fp === np);
  return { verdict: exact ? 'exact' : sameVerdict ? 'same-verdict' : 'different', wrong, missed, profitDiff, gasDiff, ...base };
}

// Repeatable sample of k items for a given round (same seed = same pick).
export function pickSample<T>(items: T[], k: number, seed: string): T[] {
  if (items.length <= k) return [...items];
  const r = rng(seed);
  const idx = items.map((_, i) => i);
  for (let i = 0; i < k; i++) { const j = i + Math.floor(r() * (idx.length - i)); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
  return idx.slice(0, k).map((i) => items[i]!);
}

// Pools to probe this round: only READY ones (when arbsim reports
// readiness), half from pools that just changed (the interesting ones),
// the rest at random.
export function choosePools(followed: string[], st: Copy2Status, recentlyChanged: string[], k: number, seed: string): { pools: string[]; readiness: 'reported' | 'not reported' } {
  const ok = st.ready ? followed.filter((p) => st.ready!.has(p)) : followed;
  const changed = recentlyChanged.filter((p) => ok.includes(p));
  const a = pickSample(changed, Math.ceil(k / 2), seed + ':changed');
  const rest = ok.filter((p) => !a.includes(p));
  return { pools: [...a, ...pickSample(rest, k - a.length, seed + ':any')], readiness: st.ready ? 'reported' : 'not reported' };
}

export class Score {
  started = Date.now();
  blocksSent = 0; logsSent = 0; transfersSent = 0; ticksSent = 0; ignoredLogs = 0; removedLogs = 0; gapsBackfilled = 0; gapBlocks = 0;
  probes: Record<ProbeVerdict, number> = { same: 0, different: 0, 'fast-unsure': 0, 'fast-missing': 0, 'node-trouble': 0 };
  probeWhy: Record<string, number> = {};
  checks: Record<CheckVerdict, number> = { exact: 0, 'same-verdict': 0, different: 0, 'fast-unsure': 0, 'fast-missing': 0, 'node-trouble': 0 };
  checkWhy: Record<string, number> = {};
  wrong = 0; missed = 0; profitDiffs: number = 0; gasDiffs: number[] = [];
  updateMs: number[] = [];   // first report of a block arrives -> copy updated (includes our wait for the block to be complete)
  applyMs: number[] = [];    // block handed to arbsim -> copy updated (arbsim's own part)
  nodeReads = 0;
  headersFetched = 0;  // block headers read from the node (header never came over the WebSocket)
  blocksNoTime = 0;    // blocks dropped: no block time even from the node
  arbsimNodeStart: number | null = null; arbsimNodeNow: number | null = null;
  arbsimPublicStart: number | null = null; arbsimPublicNow: number | null = null;
  lastStatus: Copy2Status | null = null; tracked = 0; notFollowed: Record<string, number> = {};
  trackOk: boolean | null = null; ackMode: 'answer' | 'status' | 'unknown' = 'unknown';

  addProbe(v: ProbeVerdict, why?: string) { this.probes[v]++; if (why) this.probeWhy[why] = (this.probeWhy[why] ?? 0) + 1; }
  addCheck(c: CheckCompare, why?: string) {
    this.checks[c.verdict]++;
    if (why) this.checkWhy[why] = (this.checkWhy[why] ?? 0) + 1;
    if (c.wrong) this.wrong++;
    if (c.missed) this.missed++;
    if (c.profitDiff !== null && c.profitDiff !== '0') this.profitDiffs++;
    if (c.gasDiff !== null) this.gasDiffs.push(c.gasDiff);
  }
  arbsimStatus(s: Copy2Status) {
    this.lastStatus = s;
    if (s.nodeUsedToday !== null) { this.arbsimNodeStart ??= s.nodeUsedToday; this.arbsimNodeNow = s.nodeUsedToday; }
    if (s.publicUsedToday !== null) { this.arbsimPublicStart ??= s.publicUsedToday; this.arbsimPublicNow = s.publicUsedToday; }
  }

  json(now = Date.now()): Record<string, unknown> {
    const answeredP = this.probes.same + this.probes.different;
    const allP = answeredP + this.probes['fast-unsure'] + this.probes['fast-missing'];
    const answeredC = this.checks.exact + this.checks['same-verdict'] + this.checks.different;
    const allC = answeredC + this.checks['fast-unsure'] + this.checks['fast-missing'];
    const pc = (a: number, b: number) => (b ? +(100 * a / b).toFixed(2) : null);
    const st = this.lastStatus;
    const absGas = this.gasDiffs.map(Math.abs);
    return {
      minutes: +((now - this.started) / 60_000).toFixed(1),
      feed: { blocksSent: this.blocksSent, poolLogs: this.logsSent, coinTransfers: this.transfersSent, emptyBlockTicks: this.ticksSent, ignoredLogs: this.ignoredLogs, reorgRemovedLogs: this.removedLogs, gapsBackfilled: this.gapsBackfilled, gapBlocks: this.gapBlocks, headersFetched: this.headersFetched, blocksNoTime: this.blocksNoTime },
      pools: { followed: this.tracked, notFollowed: this.notFollowed, trackAccepted: this.trackOk, copyBlock: st?.block ?? null, ready: st?.counts.ready ?? null, unsure: st?.counts.unsure ?? null, loading: st?.counts.loading ?? null, eventsApplied: st?.eventsApplied ?? null },
      slots: { probes: allP, same: this.probes.same, different: this.probes.different, fastUnsure: this.probes['fast-unsure'], fastMissing: this.probes['fast-missing'], nodeTrouble: this.probes['node-trouble'], matchPct: pc(this.probes.same, allP), matchPctWhenAnswered: pc(this.probes.same, answeredP), why: this.probeWhy },
      checks: { checks: allC, exact: this.checks.exact, sameVerdictOnly: this.checks['same-verdict'], different: this.checks.different, fastUnsure: this.checks['fast-unsure'], fastMissing: this.checks['fast-missing'], nodeTrouble: this.checks['node-trouble'],
        exactPct: pc(this.checks.exact, allC), verdictMatchPct: pc(this.checks.exact + this.checks['same-verdict'], allC), verdictMatchPctWhenAnswered: pc(this.checks.exact + this.checks['same-verdict'], answeredC),
        WRONG_fastSaidProfitNodeSaidNo: this.wrong, missed_nodeSaidProfitFastSaidNo: this.missed, profitAmountDiffers: this.profitDiffs,
        gasDiff: { n: this.gasDiffs.length, medianAbs: median(absGas), maxAbs: absGas.length ? Math.max(...absGas) : null }, why: this.checkWhy },
      nodeReads: { checker: this.nodeReads, arbsimPaid: this.arbsimNodeNow !== null && this.arbsimNodeStart !== null ? this.arbsimNodeNow - this.arbsimNodeStart : null, arbsimPublic: this.arbsimPublicNow !== null && this.arbsimPublicStart !== null ? this.arbsimPublicNow - this.arbsimPublicStart : null },
      timing: { how: this.ackMode, n: this.updateMs.length, logToCopyMs_median: median(this.updateMs), p90: pct(this.updateMs, 0.9), p99: pct(this.updateMs, 0.99), max: this.updateMs.length ? Math.max(...this.updateMs) : null,
        sendToCopyMs_median: median(this.applyMs), sendToCopyMs_p90: pct(this.applyMs, 0.9) },
    };
  }
}

// The plain-English summary (what Rudy reads).
export function summaryText(j: any, final = false): string {
  const v = (x: unknown) => (x === null || x === undefined ? '?' : String(x));
  const pctTxt = (x: unknown) => (x === null || x === undefined ? 'n/a' : `${x}%`);
  const L: string[] = [];
  L.push(`COPY 2 DRY RUN ${final ? 'FINAL' : 'progress'} summary after ${j.minutes} min (read only: nothing signed or sent)`);
  L.push('');
  L.push(`Pools: following ${j.pools.followed} pools. arbsim says: ${v(j.pools.ready)} ready, ${v(j.pools.unsure)} unsure, ${v(j.pools.loading)} loading (copy at block ${v(j.pools.copyBlock)}).`);
  const nf = Object.entries(j.pools.notFollowed ?? {});
  if (nf.length) L.push(`  Not followed by copy 2: ${nf.map(([k, n]) => `${n} (${k})`).join('; ')}.`);
  if (j.pools.trackAccepted === false) L.push('  WARNING: arbsim did not accept the pool list ("track"). Is the binary built from copy 2 (workstream A)?');
  L.push(`Feed: ${j.feed.blocksSent} blocks sent (${j.feed.poolLogs} pool reports, ${j.feed.coinTransfers} coin transfers, ${j.feed.emptyBlockTicks} empty-block ticks); ${j.feed.reorgRemovedLogs} reports taken back by the chain; ${j.feed.gapBlocks} missed blocks read back from the node; ${j.feed.headersFetched ?? 0} block times read from the node; ${j.feed.blocksNoTime ?? 0} blocks dropped (no block time).`);
  L.push('');
  L.push(`1) Pool state (price, liquidity, coin balances) copy vs node at the same block: ${j.slots.same} of ${j.slots.probes} pools identical = ${pctTxt(j.slots.matchPct)}.`);
  L.push(`   Different: ${j.slots.different}. Copy said "unsure": ${j.slots.fastUnsure}. Copy could not answer: ${j.slots.fastMissing}. (Node errors, left out: ${j.slots.nodeTrouble}.)`);
  L.push(`2) Real checks (our contract, 2-pool round trips) copy vs node: verdict same ${pctTxt(j.checks.verdictMatchPct)} of ${j.checks.checks}; byte-identical ${pctTxt(j.checks.exactPct)}.`);
  L.push(`   Different verdict: ${j.checks.different}. Copy "unsure": ${j.checks.fastUnsure}. Copy could not answer: ${j.checks.fastMissing}. (Node errors, left out: ${j.checks.nodeTrouble}.)`);
  L.push(`   WRONG (copy said profit, node said no): ${j.checks.WRONG_fastSaidProfitNodeSaidNo}. Missed (node said profit, copy said no): ${j.checks.missed_nodeSaidProfitFastSaidNo}. Profit amount differs: ${j.checks.profitAmountDiffers}.`);
  L.push(`   Gas difference (copy - node): median ${v(j.checks.gasDiff.medianAbs)}, worst ${v(j.checks.gasDiff.maxAbs)} gas over ${j.checks.gasDiff.n} checks.`);
  L.push(`Node reads used: checker ${j.nodeReads.checker}; test arbsim paid node ${v(j.nodeReads.arbsimPaid)}, free public node ${v(j.nodeReads.arbsimPublic)}.`);
  L.push(`Speed (report arrives -> copy updated, measured by ${j.timing.how}): median ${v(j.timing.logToCopyMs_median)} ms, 90% ${v(j.timing.p90)} ms, worst ${v(j.timing.max)} ms (${j.timing.n} blocks).`);
  L.push(`   of which arbsim itself (block handed over -> copy updated): median ${v(j.timing.sendToCopyMs_median)} ms, 90% ${v(j.timing.sendToCopyMs_p90)} ms; the rest is waiting until the block's reports are complete (--grace-ms).`);
  const verdict = j.checks.WRONG_fastSaidProfitNodeSaidNo > 0 || j.slots.different > 0 || j.checks.different > 0
    ? 'NOT READY: the copy disagreed with the node (see probes.jsonl / checks.jsonl for each case).'
    : (j.slots.probes + j.checks.checks) === 0 ? 'NO DATA YET.'
    : 'So far no disagreement with the node.';
  L.push('');
  L.push(`Bottom line: ${verdict}`);
  return L.join('\n');
}

export { hex };
