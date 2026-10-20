// ============================================================================
// SIM-COMPARE step 1: COLLECT the checks the bot would have run.
//
// Plain English:
//   For a range of past Robinhood blocks:
//   (a) FOLLOW-A-TRADE checks: every transaction that traded on a pool the
//       bot watches (found from the pools' own Swap/Sync events, read with the
//       bot's own event parser), and for each one the 2-pool round trips the
//       bot would test right after it (that pool against every other watched
//       pool of the same coin pair, both directions, a few sizes, plus one
//       flash-loan version). Like the bot, the check replays the trade's
//       block up to and including that trade, then runs ours.
//   (b) STANDING-GAP checks: every Nth block, a repeatable random sample of
//       routes tested on the state at the start of that block.
//
//   The exact request is not rebuilt by us: we run the bot's own
//   simulateRoundTrip and catch the eth_call it is about to send (calldata,
//   pretend balances, contract code, lender allowlist). So the harness checks
//   precisely what the bot asks, byte for byte.
//
// Node use: one eth_getLogs per chunk of blocks, one eth_getBlockByNumber per
// block with a trigger trade, and (once per start coin, then saved) the
// token balance-slot lookup. Nothing else.
// ============================================================================
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { Rpc, simulateRoundTrip, SIM_EXECUTOR_ADDRESS, setSimDiagnosticLog, isRateLimited } from '../../src/execution/simulator';
import { ARB_EXECUTOR_RUNTIME_CODE } from '../../src/execution/arbExecutorBytecode';
import { HANDLED_TOPICS, parsePoolLogs, RpcLog } from '../../src/core/blockReader';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY } from '../../src/core/decoder';
import { seedKnownAddresses, ROBINHOOD_TOKENS } from '../../src/config/knownAddresses';
import { PoolState } from '../../src/core/types';
import { BlockPrefix, Case, CallObj } from './types';
import { PoolBook, RouteSpec, SizeConfig, routesThrough, allRoutes, flashLendersFromEnv } from './pools';
import { appendJsonl, hex, lc, readJson, sample, sha, writeJsonAtomic, readJsonl } from './util';

// Same rule as the bot (shadowMain.ts findTriggerSpot, USER_TX_TYPES): only
// ordinary user transactions are replayed; Arbitrum's own system
// transactions (types 0x64-0x6a) and contract creations are skipped.
export const USER_TX_TYPES = new Set(['0x0', '0x1', '0x2', '0x3', '0x4']);

export const EXECUTOR_CODE_HASH = sha(ARB_EXECUTOR_RUNTIME_CODE, 32);
export const EXECUTOR_PLACEHOLDER = '@executor';

// Swap out / put back the 20 KB contract code inside a case's overrides.
export function packOverrides(o: Record<string, any>): Record<string, any> {
  const out = JSON.parse(JSON.stringify(o));
  const ex = out[SIM_EXECUTOR_ADDRESS];
  if (ex && ex.code === ARB_EXECUTOR_RUNTIME_CODE) ex.code = EXECUTOR_PLACEHOLDER;
  return out;
}
export function unpackOverrides(c: Pick<Case, 'overrides' | 'executorCodeHash'>): Record<string, any> {
  if (c.executorCodeHash !== EXECUTOR_CODE_HASH) {
    throw new Error('the bot\'s contract code changed since these checks were collected; collect again (new --out folder)');
  }
  const out = JSON.parse(JSON.stringify(c.overrides));
  const ex = out[SIM_EXECUTOR_ADDRESS];
  if (ex && ex.code === EXECUTOR_PLACEHOLDER) ex.code = ARB_EXECUTOR_RUNTIME_CODE;
  return out;
}

// ---- Capture what simulateRoundTrip sends -----------------------------------
export type Captured = { call: CallObj; tag: string; overrides: Record<string, any> };

// Runs the bot's simulateRoundTrip with a stand-in node: the token balance
// slot lookup goes to the real node (`slotRpc`, cached and saved after the
// first time), and the final eth_call to our pretend contract is caught and
// returned instead of being sent. Returns a reason text when the bot itself
// would not have sent the check (e.g. balance slot not found).
export async function captureCheck(slotRpc: Rpc, route: RouteSpec, blockTag: string): Promise<Captured | { refused: string; transient: boolean }> {
  let got: unknown[] | null = null;
  const rpc: Rpc = async (method, params) => {
    const p = params as any[];
    if (method === 'eth_call' && lc(String(p[0]?.to ?? '')) === SIM_EXECUTOR_ADDRESS) {
      got = params;
      return { error: { message: 'captured by sim-compare (not sent)' } };
    }
    return slotRpc(method, params);
  };
  const r = await simulateRoundTrip(rpc, 'robinhood', { token: route.token, amountIn: route.amountIn, hops: route.hops },
    { ...(route.v3Lender ? { v3Lender: route.v3Lender } : {}), weth: ROBINHOOD_TOKENS.WETH, blockTag });
  if (!got) return { refused: `${r.status}: ${'reason' in r ? r.reason : ''}`, transient: r.status === 'rate_limited' };
  const [call, tag, overrides] = got as [CallObj, string, Record<string, any>];
  return { call: { ...call }, tag, overrides: overrides ?? {} };
}

// ---- Finding trigger trades from pool events --------------------------------
export interface Trigger { block: number; txIndex: number; txHash: string; pool: string }

// The addresses whose events we read: every watched pool, plus the Uniswap
// V4 PoolManager(s) when V4 pools are watched (V4 events come from there and
// name the pool by its id).
export function watchAddresses(book: PoolBook): { addresses: string[]; poolManagers: string[]; v4Ids: Set<string> } {
  const addrs = new Set<string>();
  const pms = new Set<string>();
  const v4Ids = new Set<string>();
  for (const p of book.pools.values()) {
    if (p.v4) { pms.add(lc(p.v4.poolManager)); v4Ids.add(lc(p.poolAddress)); }
    else addrs.add(lc(p.poolAddress));
  }
  return { addresses: [...addrs, ...pms], poolManagers: [...pms], v4Ids };
}

// Logs -> one trigger per (transaction, watched pool). The bot's own event
// parser (core/blockReader.ts parsePoolLogs) decides what counts as a trade.
export function triggersFromLogs(logs: RpcLog[], book: PoolBook): Trigger[] {
  const { poolManagers } = watchAddresses(book);
  const seen = new Set<string>();
  const out: Trigger[] = [];
  for (const l of logs) {
    if (!l || l.removed || !l.transactionHash || l.transactionIndex === undefined) continue;
    let ok = false;
    let pool = '';
    for (const pm of poolManagers.length ? poolManagers : ['']) {
      const u = parsePoolLogs([l], pm)[0];
      if (u && book.pools.has(u.pool)) { ok = true; pool = u.pool; break; }
    }
    if (!ok) continue;
    const key = `${lc(l.transactionHash)}:${pool}`;
    if (seen.has(key)) continue; // several events of one trade on one pool
    seen.add(key);
    out.push({ block: Number(BigInt(l.blockNumber)), txIndex: Number(BigInt(l.transactionIndex)), txHash: lc(l.transactionHash), pool });
  }
  return out.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex);
}

// eth_getLogs over a block range, splitting the range when the node refuses
// a big one ("too many results", "range too large", timeouts).
export async function getLogsSplit(rpc: Rpc, addresses: string[], from: number, to: number, onReq?: () => void): Promise<RpcLog[]> {
  if (!addresses.length || from > to) return [];
  onReq?.();
  const r = await rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: addresses, topics: [HANDLED_TOPICS] }]);
  if (!r.error && Array.isArray(r.result)) return r.result as RpcLog[];
  if (r.error && (isRateLimited(r.error) || /cap reached/.test(String(r.error.message)))) throw new Error(`node refused logs: ${r.error.message}`);
  if (from === to) throw new Error(`node refused logs for block ${from}: ${r.error?.message ?? 'no result'}`);
  const mid = Math.floor((from + to) / 2);
  return [...await getLogsSplit(rpc, addresses, from, mid, onReq), ...await getLogsSplit(rpc, addresses, mid + 1, to, onReq)];
}

// The user transactions of a block, in order (system txs skipped, like the bot).
export function blockPrefixOf(block: any, uptoIndex: number): BlockPrefix {
  const n = Number(BigInt(block.number));
  const txs: any[] = block.transactions ?? [];
  const calls: BlockPrefix['calls'] = [];
  for (let i = 0; i <= uptoIndex && i < txs.length; i++) {
    const t = txs[i];
    if (!t || typeof t !== 'object' || !t.to || !USER_TX_TYPES.has(String(t.type ?? '0x0').toLowerCase())) continue;
    calls.push({ i, hash: lc(String(t.hash)), from: t.from, to: t.to, data: t.input ?? t.data ?? '0x', value: t.value, gas: t.gas });
  }
  return { block: n, parent: n - 1, time: block.timestamp, calls };
}

// ---- The collector ----------------------------------------------------------
export interface CollectOptions {
  out: string;               // run folder
  from: number; to: number;
  sizes: SizeConfig;
  maxCases: number;
  maxRoutesPerTrigger: number;
  standingEvery: number;     // 0 = no standing-gap checks
  standingRoutes: number;
  tradeShare: number;        // 0-1: share of trades followed (repeatable pick by tx hash); spreads --max-cases over a long range
  logChunk: number;
  resume: boolean;
  stop: () => boolean;       // Ctrl-C pressed?
  log: (m: string) => void;
}

export interface CollectStats {
  logRequests: number; blockRequests: number; triggers: number; triggerBlocks: number;
  triggerCases: number; standingCases: number; refused: Record<string, number>;
  decodedByBot: number; notDecodedByBot: number; skippedTriggers: Record<string, number>;
}

export async function collectCases(rpc: Rpc, book: PoolBook, o: CollectOptions): Promise<CollectStats> {
  setSimDiagnosticLog(() => {}); // the bot's "[sim-diag]" lines would be noise here
  const casesFile = join(o.out, 'cases.jsonl');
  const progFile = join(o.out, 'collect-progress.json');
  mkdirSync(join(o.out, 'blocks'), { recursive: true });
  const stats: CollectStats = { logRequests: 0, blockRequests: 0, triggers: 0, triggerBlocks: 0, triggerCases: 0, standingCases: 0, refused: {}, decodedByBot: 0, notDecodedByBot: 0, skippedTriggers: {} };
  const skipT = (why: string) => { stats.skippedTriggers[why] = (stats.skippedTriggers[why] ?? 0) + 1; };

  // Resume: continue after the last finished chunk, never write a case twice.
  const have = new Set<string>();
  let start = o.from;
  if (o.resume) {
    for await (const c of readJsonl<Case>(casesFile)) have.add(c.id);
    const prog = readJson<{ from: number; to: number; next: number }>(progFile);
    if (prog && prog.from === o.from && prog.to === o.to) start = Math.max(o.from, prog.next);
  }
  let total = have.size;

  const registry = structuredClone(DEFAULT_ROUTER_REGISTRY);
  seedKnownAddresses(registry);
  const decoder = new TransactionDecoder(registry, undefined, (_c, a) => book.pools.get(lc(a)));
  const flashLenders = flashLendersFromEnv();
  const { addresses } = watchAddresses(book);

  // Built once: the exact request per route (it doesn't depend on the block
  // except for the block tag, which is filled in per case).
  const captureCache = new Map<string, Captured | { refused: string; transient: boolean }>();
  const routeKey = (r: RouteSpec) => `${lc(r.buyPool.poolAddress)}>${lc(r.sellPool.poolAddress)}|${r.amountIn}|${r.v3Lender ?? ''}`;
  const capture = async (r: RouteSpec): Promise<Captured | null> => {
    let c = captureCache.get(routeKey(r));
    if (!c || ('refused' in c && c.transient)) {
      c = await captureCheck(rpc, r, 'latest');
      // Kept with the 20 KB contract code swapped for its placeholder, so the
      // cache stays small however many routes the watch list has.
      if (!('refused' in c)) c = { ...c, overrides: packOverrides(c.overrides) };
      captureCache.set(routeKey(r), c);
    }
    if ('refused' in c) { stats.refused[c.refused] = (stats.refused[c.refused] ?? 0) + 1; return null; }
    return c;
  };

  const writeCase = (c: Omit<Case, 'id'>): boolean => {
    const id = sha(JSON.stringify([c.mode, c.block, c.txIndex, c.triggerHash, c.call.data, c.tag, c.overrides]));
    if (have.has(id)) return false;
    have.add(id);
    appendJsonl(casesFile, { ...c, id });
    total++;
    return true;
  };
  const caseOf = (mode: Case['mode'], block: number, cap: Captured, r: RouteSpec, tag: string, extra: Partial<Case>): Omit<Case, 'id'> => ({
    v: 1, mode, block, parent: block - 1, time: null, txIndex: null, triggerHash: null, triggerPool: null, decodedByBot: null, prefixLen: 0,
    route: {
      pair: r.pair, token: r.token, amountIn: r.amountIn.toString(), sizeLabel: r.sizeLabel, hops: r.hops, kinds: r.kinds,
      buyPool: r.buyPool.poolAddress, sellPool: r.sellPool.poolAddress, buyDex: r.buyPool.dex, sellDex: r.sellPool.dex,
    },
    funding: r.funding, v3Lender: r.v3Lender, call: cap.call, tag, overrides: cap.overrides /* already packed */, executorCodeHash: EXECUTOR_CODE_HASH,
    ...extra,
  });

  const allR = o.standingEvery > 0 ? allRoutes(book, o.sizes, stats.refused, flashLenders) : [];
  // Progress line every 30 s (a chunk with many trades can take minutes).
  let at = start;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const doneBlocks = at - o.from, all = o.to - o.from + 1;
    const rate = doneBlocks / Math.max(1, (Date.now() - t0) / 1000);
    o.log(`[collect] block ${at} (${doneBlocks}/${all}) · ${total} checks · ${stats.triggers} trades · ${stats.logRequests + stats.blockRequests} log/block requests${rate > 0 ? ` · ~${Math.ceil((all - doneBlocks) / rate / 60)} min left` : ''}`);
  }, 30_000);
  timer.unref?.();
  try {
  for (let a = start; a <= o.to && !o.stop() && total < o.maxCases; a += o.logChunk) {
    const b = Math.min(o.to, a + o.logChunk - 1);
    const logs = await getLogsSplit(rpc, addresses, a, b, () => stats.logRequests++);
    const trig = triggersFromLogs(logs, book).filter((t) => o.tradeShare >= 1 || parseInt(sha(t.txHash, 8), 16) / 0xffffffff < o.tradeShare);
    stats.triggers += trig.length;
    const byBlock = new Map<number, Trigger[]>();
    for (const t of trig) (byBlock.get(t.block) ?? byBlock.set(t.block, []).get(t.block)!).push(t);

    // Blocks of this chunk in order: trigger checks, then the standing sample.
    const blocks = new Set<number>([...byBlock.keys()]);
    if (o.standingEvery > 0) for (let n = a; n <= b; n++) if ((n - o.from) % o.standingEvery === 0) blocks.add(n);
    for (const n of [...blocks].sort((x, y) => x - y)) {
      if (o.stop() || total >= o.maxCases) break;
      at = n;
      const ts = byBlock.get(n) ?? [];
      if (ts.length) {
        // One block read: every user tx up to the last trigger, saved for the check step.
        const blockFile = join(o.out, 'blocks', `${n}.json`);
        let pre = readJson<BlockPrefix & { fullHashes?: string[] }>(blockFile);
        let hashes: string[] | null = pre?.fullHashes ?? null;
        if (!pre) {
          stats.blockRequests++;
          const r = await rpc('eth_getBlockByNumber', [hex(n), true]);
          if (r.error || !r.result) { for (const _ of ts) skipT(`block read failed: ${String(r.error?.message ?? 'empty').slice(0, 60)}`); continue; }
          const maxIdx = Math.max(...ts.map((t) => t.txIndex));
          pre = blockPrefixOf(r.result, maxIdx);
          hashes = (r.result.transactions ?? []).map((t: any) => lc(String(t?.hash ?? t)));
          // The header too, so fixture mode needs no extra request for it.
          const h = r.result;
          const header = { number: h.number, l1BlockNumber: h.l1BlockNumber, timestamp: h.timestamp, baseFeePerGas: h.baseFeePerGas, miner: h.miner, gasLimit: h.gasLimit, mixHash: h.mixHash, difficulty: h.difficulty };
          writeJsonAtomic(blockFile, { ...pre, fullHashes: hashes, header });
          // Which triggers would the bot's feed decoder have recognised? (info only)
          for (const t of ts) {
            const tx = r.result.transactions?.[t.txIndex];
            const d = tx && tx.to ? await decoder.decode({ chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: n, receivedAtMs: 0, raw: { to: tx.to, data: tx.input, value: tx.value } }).catch(() => null) : null;
            (t as Trigger & { dec?: boolean }).dec = !!d;
          }
        }
        stats.triggerBlocks++;
        for (const t of ts) {
          if (o.stop() || total >= o.maxCases) break;
          if (!hashes || hashes[t.txIndex] !== t.txHash) { skipT('trigger not at its index in the block'); continue; }
          const prefix = pre.calls.filter((c) => c.i <= t.txIndex);
          if (!prefix.length || prefix[prefix.length - 1]!.hash !== t.txHash) { skipT('trigger is not a replayable user tx (contract creation / system tx)'); continue; }
          const p = book.pools.get(t.pool) as PoolState;
          let routes = dedupeRoutes(routesThrough(book, p, o.sizes, stats.refused, flashLenders));
          if (!routes.length) { skipT('no partner pool / no buildable route'); continue; }
          routes = pickRoutes(routes, o.maxRoutesPerTrigger, `${t.txHash}:${t.pool}`);
          const dec = (t as Trigger & { dec?: boolean }).dec;
          if (dec === true) stats.decodedByBot++; else if (dec === false) stats.notDecodedByBot++;
          for (const r of routes) {
            if (total >= o.maxCases) break;
            const cap = await capture(r);
            if (!cap) continue;
            // Trigger checks go through replayRpc, which ignores the tag;
            // stored as the parent block for clarity.
            const tag = hex(n - 1);
            if (writeCase(caseOf('trigger', n, cap, r, tag, {
              time: pre.time, txIndex: t.txIndex, triggerHash: t.txHash, triggerPool: t.pool, decodedByBot: dec ?? null, prefixLen: prefix.length,
            }))) stats.triggerCases++;
          }
        }
      }
      if (o.standingEvery > 0 && (n - o.from) % o.standingEvery === 0 && allR.length) {
        for (const r of sample(allR, o.standingRoutes, `standing:${n}`)) {
          if (total >= o.maxCases) break;
          const cap = await capture(r);
          if (!cap) continue;
          if (writeCase(caseOf('standing', n, cap, r, hex(n - 1), {}))) stats.standingCases++;
        }
      }
    }
    // Chunk finished (or stopped part-way: then it is redone on resume, and
    // cases already written are recognised by their id and not repeated).
    if (!o.stop() && total < o.maxCases) writeJsonAtomic(progFile, { from: o.from, to: o.to, next: b + 1 });
    o.log(`[collect] blocks ${a}-${b}: ${trig.length} trades on watched pools, ${total} checks so far`);
  }
  } finally { clearInterval(timer); }
  if (!existsSync(progFile)) writeJsonAtomic(progFile, { from: o.from, to: o.to, next: o.from });
  return stats;
}

// The same pool pair can show up twice for one trade (the trade touched both
// pools). Keep each (buy, sell, amount, lender) once.
export function dedupeRoutes(rs: RouteSpec[]): RouteSpec[] {
  const seen = new Set<string>();
  return rs.filter((r) => {
    const k = `${lc(r.buyPool.poolAddress)}>${lc(r.sellPool.poolAddress)}|${r.amountIn}|${r.v3Lender ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// At most `k` routes per trade, chosen repeatably; at least one flash-loan
// route is kept when there is one, so both contract entry points are tested.
export function pickRoutes(rs: RouteSpec[], k: number, seed: string): RouteSpec[] {
  if (rs.length <= k) return rs;
  const flash = rs.filter((r) => r.funding === 'flash');
  const own = rs.filter((r) => r.funding === 'own');
  const f = flash.length ? sample(flash, 1, seed + ':f') : [];
  return [...f, ...sample([...own, ...flash.filter((x) => !f.includes(x))], k - f.length, seed)];
}

// Small helper for tests and the README: the ABI of the contract's entry points.
export const executeSelector = (data: string) => data.slice(0, 10);
export { ethers };
