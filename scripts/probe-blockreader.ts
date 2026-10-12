// ============================================================================
// BLOCK READER LIVE CHECK (research, read-only, never sends anything)
//
// Plain English:
//   The "block reader" (src/core/blockReader.ts) asks the node, about 9 times
//   a second, for the newest swaps on the pools the bot watches, and turns
//   each one into the exact pool state after that swap. This probe runs the
//   real reader against the real Robinhood Chain node and checks two things:
//
//   1. KEEPS UP: does it cover every block, how far behind the newest block
//      is it, and how often does the free node refuse or fail?
//   2. CORRECT: for a sample of the states it reports, ask the pool itself
//      (or the V4 "StateView" helper) what its state was at that exact block.
//      If the numbers are identical, the reader decodes the events right.
//      A state is only compared when the reported event was the LAST event
//      for that pool in its block; otherwise a later event in the same block
//      would have changed the pool again and the comparison means nothing.
//
//   Steps:
//     a. Pick pools: the busiest pools of the last ~300 blocks (top 60 pool
//        contracts plus the top 20 Uniswap V4 pools).
//     b. Run the reader for BR_MINUTES with one poll every 110 ms.
//     c. Check every 10th update (up to 150) the moment it arrives. The
//        public node keeps very little history, so the check must happen
//        right away; checks the node can no longer answer are counted as
//        "unreadable", not as errors of the reader.
//
//   Result: one GitHub annotation titled "Block reader live check".
//
// Settings (environment):
//   ROBINHOOD_RPC_URL (default: the public node), BR_MINUTES (default 8),
//   BR_POLL_MS (default 110), BR_SELECT_BLOCKS (default 300), BR_POOLS
//   (default 60), BR_V4_POOLS (default 20), BR_SAMPLE_EVERY (default 10),
//   BR_MAX_CHECKS (default 150)
// Run: npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-blockreader.js
// ============================================================================
import { ethers } from 'ethers';
import { parsePoolLogs, latestPerPool, BlockReader } from '../src/core/blockReader';
import type { PoolUpdate, RpcLog } from '../src/core/blockReader';

// ---- settings ----------------------------------------------------------------
const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const MINUTES = Number(process.env.BR_MINUTES ?? 8);
const POLL_MS = Number(process.env.BR_POLL_MS ?? 110);
const SELECT_BLOCKS = Number(process.env.BR_SELECT_BLOCKS ?? 300);
const TOP_POOLS = Number(process.env.BR_POOLS ?? 60);
const TOP_V4 = Number(process.env.BR_V4_POOLS ?? 20);
const SAMPLE_EVERY = Math.max(1, Number(process.env.BR_SAMPLE_EVERY ?? 10));
const MAX_CHECKS = Number(process.env.BR_MAX_CHECKS ?? 150);
// At most this many checks talk to the node at the same time, so the checks
// never crowd out the reader itself.
const MAX_IN_FLIGHT = 6;

// Uniswap V4 contracts on Robinhood Chain (lowercase).
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';

// ---- the events the reader handles (same list as the spec) -------------------
const T_SYNC = ethers.id('Sync(uint112,uint112)');
const T_V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const T_PCS = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');
const T_ALGEBRA = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)');
const T_V4 = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const HANDLED = [T_SYNC, T_V3, T_PCS, T_ALGEBRA, T_V4];
// Solidly / Velodrome style pools announce reserves with uint256 numbers, which
// is a DIFFERENT event fingerprint. The spec does not list it, so the probe only
// counts how common it is, to show whether the reader is missing those pools.
const T_SYNC_256 = ethers.id('Sync(uint256,uint256)');

// ---- function fingerprints for reading pool state ----------------------------
const SEL_GET_RESERVES = '0x0902f1ac';  // V2: getReserves()
const SEL_SLOT0 = '0x3850c7bd';         // V3 / Slipstream / Pancake: slot0()
const SEL_LIQUIDITY = '0x1a686502';     // V3 family: liquidity()
const SEL_GLOBAL_STATE = '0xe76c01e4';  // Algebra: globalState()
const SEL_V4_SLOT0 = ethers.id('getSlot0(bytes32)').slice(0, 10);
const SEL_V4_LIQUIDITY = ethers.id('getLiquidity(bytes32)').slice(0, 10);

// ---- small helpers -----------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
// The Nth 32-byte number in an answer from the node (null if the answer is too short).
const word = (hex: string, i: number): bigint | null => (hex && hex.length >= 2 + 64 * (i + 1) ? BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null);
// A tick is a signed 24-bit number stored inside a 32-byte word.
const tick24 = (v: bigint): number => { const x = Number(v & 0xffffffn); return x >= 0x800000 ? x - 0x1000000 : x; };
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 8)}..${s.slice(-4)}` : s);

// An error from the node, remembering whether it was a "slow down" refusal.
class RpcError extends Error {
  constructor(message: string, public rateLimited: boolean) { super(message); }
}

// One request to the node. Throws RpcError on any failure. Read-only methods only.
async function rpc(method: string, params: unknown[]): Promise<any> {
  let res: Response;
  try {
    res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) { throw new RpcError(`network: ${String((e as Error).message).slice(0, 60)}`, false); }
  if (res.status === 429) throw new RpcError('HTTP 429 rate limited', true);
  if (!res.ok) throw new RpcError(`HTTP ${res.status}`, false);
  const j: any = await res.json().catch(() => null);
  if (!j) throw new RpcError('bad JSON from node', false);
  if (j.error) {
    const m = String(j.error.message ?? j.error.code ?? 'unknown error');
    throw new RpcError(m.slice(0, 120), /429|rate|limit|too many/i.test(m));
  }
  return j.result;
}

// Same as rpc() but waits and retries when the node says "slow down". Used only
// during setup, where speed does not matter.
async function rpcPatient(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try { return await rpc(method, params); }
    catch (e) {
      if (attempt >= 4) throw e;
      await sleep((e as RpcError).rateLimited ? 2_000 * (attempt + 1) : 500);
    }
  }
}

function annotate(title: string, lines: string[]) {
  const body = lines.join('\n');
  console.log(`----- ${title} -----\n${body}`);
  console.log(`::notice title=${title}::${body.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
}

// ---- step a: pick the pools to watch -----------------------------------------
async function pickPools(head: number) {
  const byPool = new Map<string, number>();
  const byV4 = new Map<string, number>();
  const solidly = new Map<string, number>();
  const allLogs: RpcLog[] = [];
  // Ask in chunks of 100 blocks so no single answer gets too big.
  const from = head - SELECT_BLOCKS + 1;
  for (let a = from; a <= head; a += 100) {
    const b = Math.min(head, a + 99);
    const logs: RpcLog[] = await rpcPatient('eth_getLogs', [{ fromBlock: ethers.toQuantity(a), toBlock: ethers.toQuantity(b), topics: [[...HANDLED, T_SYNC_256]] }]);
    for (const l of logs ?? []) {
      if (l.removed) continue;
      const addr = l.address.toLowerCase();
      const t0 = l.topics[0];
      if (t0 === T_SYNC_256) { solidly.set(addr, (solidly.get(addr) ?? 0) + 1); continue; }
      allLogs.push(l);
      if (addr === POOL_MANAGER) {
        if (t0 === T_V4 && l.topics[1]) { const id = l.topics[1].toLowerCase(); byV4.set(id, (byV4.get(id) ?? 0) + 1); }
      } else byPool.set(addr, (byPool.get(addr) ?? 0) + 1);
    }
  }
  const top = <K>(m: Map<K, number>, n: number) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k]) => k);
  const pools = top(byPool, TOP_POOLS);
  const v4 = top(byV4, TOP_V4);
  // Quick offline sanity check of the pure parser on the same logs: how many
  // updates it decodes per kind before the live run even starts.
  const parsed = parsePoolLogs(allLogs, POOL_MANAGER);
  const parsedKinds = { v2: 0, v3: 0, v4: 0 };
  for (const u of parsed) parsedKinds[u.kind]++;
  const latestCount = latestPerPool(parsed).size;
  return {
    pools, v4,
    selectionLine: `Picked from blocks ${from}..${head}: ${byPool.size} pools + ${byV4.size} V4 pools active, watching ${pools.length} + ${v4.length}. ` +
      `Parser on those ${allLogs.length} logs: v2 ${parsedKinds.v2}, v3 ${parsedKinds.v3}, v4 ${parsedKinds.v4} updates, ${latestCount} distinct pools.`,
    solidlyLine: solidly.size
      ? `Solidly-style Sync(uint256,uint256): ${[...solidly.values()].reduce((a, b) => a + b, 0)} events from ${solidly.size} pools in the window. The spec does not handle this event, so those pools get no updates.`
      : 'Solidly-style Sync(uint256,uint256): none seen in the window.',
  };
}

// ---- step c: check one update against the chain ------------------------------
type Field = 'reserve0' | 'reserve1' | 'sqrtPriceX96' | 'liquidity' | 'tick';
type CheckResult =
  | { status: 'match' }
  | { status: 'mismatch'; detail: string }
  | { status: 'later-event' }               // another event changed the pool later in the same block
  | { status: 'unreadable'; reason: string }; // node could not answer for that block

const isRevert = (e: unknown) => /revert/i.test(String((e as Error)?.message ?? e));
const reasonOf = (e: unknown) => ((e as RpcError)?.rateLimited ? 'rate-limited' : /network|HTTP 5/i.test(String((e as Error)?.message)) ? 'node error' : 'history gone');

async function checkUpdate(u: PoolUpdate): Promise<CheckResult> {
  const tag = ethers.toQuantity(u.block);
  const call = (to: string, data: string) => rpc('eth_call', [{ to, data }, tag]);

  // 1. Every event of this pool in that one block, to confirm the reported
  //    event was the last one that could change the pool's state.
  const logsReq: Promise<RpcLog[]> = u.kind === 'v4'
    ? rpc('eth_getLogs', [{ fromBlock: tag, toBlock: tag, address: POOL_MANAGER, topics: [null, u.pool] }])
    : rpc('eth_getLogs', [{ fromBlock: tag, toBlock: tag, address: u.pool }]);

  // 2. The pool's state at that block, asked at the same moment.
  let stateReq: Promise<Partial<Record<Field, bigint | number>>>;
  if (u.kind === 'v2') {
    stateReq = call(u.pool, SEL_GET_RESERVES).then((r: string) => ({ reserve0: word(r, 0) ?? -1n, reserve1: word(r, 1) ?? -1n }));
  } else if (u.kind === 'v4') {
    const id = u.pool.replace(/^0x/, '').padStart(64, '0');
    stateReq = Promise.all([call(STATE_VIEW, SEL_V4_SLOT0 + id), call(STATE_VIEW, SEL_V4_LIQUIDITY + id)])
      .then(([s, l]: string[]) => ({ sqrtPriceX96: word(s!, 0) ?? -1n, tick: tick24(word(s!, 1) ?? 0n), liquidity: word(l!, 0) ?? -1n }));
  } else {
    // V3, Slipstream and Pancake answer slot0(); Algebra pools refuse it and
    // answer globalState() instead (first number = price, second = tick).
    stateReq = Promise.all([
      call(u.pool, SEL_SLOT0).catch(async (e) => { if (!isRevert(e)) throw e; return call(u.pool, SEL_GLOBAL_STATE); }),
      call(u.pool, SEL_LIQUIDITY),
    ]).then(([s, l]: string[]) => ({ sqrtPriceX96: word(s!, 0) ?? -1n, tick: tick24(word(s!, 1) ?? 0n), liquidity: word(l!, 0) ?? -1n }));
  }

  const [logsRes, stateRes] = await Promise.allSettled([logsReq, stateReq]);
  if (logsRes.status === 'rejected') return { status: 'unreadable', reason: reasonOf(logsRes.reason) };

  // Was there a later state-changing event for this pool in the same block?
  // V2: only a later Sync changes reserves. V3/V4: be strict, any later event
  // of that pool (swap, add/remove liquidity, ...) means skip.
  const later = (logsRes.value ?? []).some((l) => !l.removed && Number(l.logIndex) > u.logIndex && (u.kind !== 'v2' || l.topics[0] === T_SYNC));
  if (later) return { status: 'later-event' };

  if (stateRes.status === 'rejected') return { status: 'unreadable', reason: isRevert(stateRes.reason) ? 'state call refused by pool' : reasonOf(stateRes.reason) };
  const chain = stateRes.value;

  // Compare every number the update carries with what the chain says.
  const diffs: string[] = [];
  for (const f of ['reserve0', 'reserve1', 'sqrtPriceX96', 'liquidity', 'tick'] as Field[]) {
    const got = u[f];
    if (got === undefined || chain[f] === undefined) continue;
    if (String(chain[f]) !== String(got)) diffs.push(`${f} expected ${String(chain[f])} got ${String(got)}`);
  }
  return diffs.length ? { status: 'mismatch', detail: `${u.kind} ${short(u.pool)} block ${u.block}: ${diffs.join('; ')}` } : { status: 'match' };
}

// ---- main ----------------------------------------------------------------------
(async () => {
  const headStart0 = Number(await rpcPatient('eth_blockNumber', []));
  const sel = await pickPools(headStart0);
  if (!sel.pools.length && !sel.v4.length) {
    annotate('Block reader live check', [`No active pools found in the last ${SELECT_BLOCKS} blocks; nothing to watch.`, sel.solidlyLine]);
    process.exit(0);
  }
  const addresses = sel.pools;
  const v4Ids = new Set(sel.v4);

  // Counters filled while the reader runs.
  const kinds = { v2: 0, v3: 0, v4: 0 };
  let updatesSeen = 0, checkDue = false, checksStarted = 0, inFlight = 0;
  let matches = 0, laterEvent = 0;
  const mismatches: string[] = [];
  const unreadable = new Map<string, number>();
  let readerRequests = 0, readerRefusals = 0;
  const lagSamples: number[] = [];

  // The reader's link to the node, wrapped so the probe can count requests
  // and refusals on its own (a cross-check of the reader's own numbers).
  const readerRpc = async (method: string, params: unknown[]) => {
    readerRequests++;
    try { return await rpc(method, params); }
    catch (e) { if ((e as RpcError).rateLimited) readerRefusals++; throw e; }
  };

  const runCheck = (u: PoolUpdate) => {
    checksStarted++; inFlight++;
    checkUpdate(u)
      .then((r) => {
        if (r.status === 'match') matches++;
        else if (r.status === 'mismatch') mismatches.push(r.detail);
        else if (r.status === 'later-event') laterEvent++;
        else unreadable.set(r.reason, (unreadable.get(r.reason) ?? 0) + 1);
      })
      .catch((e) => { const k = `probe error: ${String((e as Error).message).slice(0, 40)}`; unreadable.set(k, (unreadable.get(k) ?? 0) + 1); })
      .finally(() => { inFlight--; });
  };

  const headStart = Number(await rpcPatient('eth_blockNumber', []));
  const reader = new BlockReader({
    rpc: readerRpc,
    poolManager: POOL_MANAGER,
    addresses: () => addresses,
    v4Ids: () => v4Ids,
    pollMs: POLL_MS,
    onUpdates: (latest) => {
      for (const u of latest.values()) {
        kinds[u.kind] = (kinds[u.kind] ?? 0) + 1;
        updatesSeen++;
        if (updatesSeen % SAMPLE_EVERY === 0) checkDue = true;
        // Check right away (history disappears fast). If too many checks are
        // already running, the next update takes this one's place.
        if (checkDue && checksStarted < MAX_CHECKS && inFlight < MAX_IN_FLIGHT) { checkDue = false; runCheck(u); }
      }
    },
  });
  reader.start();

  // Once a second, ask the node for its newest block on our own and note how
  // many blocks behind the reader is.
  const lagTimer = setInterval(() => {
    rpc('eth_blockNumber', []).then((h) => {
      const last = reader.stats().lastBlock;
      if (last > 0) lagSamples.push(Math.max(0, Number(h) - last));
    }).catch(() => { /* a missed sample is fine */ });
  }, 1_000);

  await sleep(MINUTES * 60_000);
  reader.stop();
  clearInterval(lagTimer);
  // Let checks that are still talking to the node finish (at most 15 s).
  for (let i = 0; i < 150 && inFlight > 0; i++) await sleep(100);

  const headEnd = Number(await rpcPatient('eth_blockNumber', []).catch(() => headStart));
  const s = reader.stats();
  const covered = s.lastBlock - headStart;
  const headAdvance = headEnd - headStart;
  const validated = matches + mismatches.length;
  const unreadableTotal = [...unreadable.values()].reduce((a, b) => a + b, 0);

  annotate('Block reader live check', [
    `Node ${RPC_URL.replace(/\/v2\/.*/, '/v2/***')}, ${MINUTES} min, poll every ${POLL_MS} ms. ${sel.selectionLine}`,
    `Polls ${s.polls}: ok ${s.ok}, errors ${s.errors}, rate-limited ${s.rateLimited}; median poll ${s.medianMs} ms. Probe count: ${readerRequests} reader requests, ${readerRefusals} refused as rate-limited.`,
    `Blocks covered ${covered} vs head advance ${headAdvance} (${headAdvance > 0 ? ((100 * covered) / headAdvance).toFixed(1) : '0'}%); skipped ranges ${s.skippedRanges}.`,
    `Lag behind newest block: median ${median(lagSamples)}, max ${lagSamples.length ? Math.max(...lagSamples) : 0} blocks (${lagSamples.length} samples; reader's own figure at end ${s.lagBlocks}).`,
    `Updates received ${updatesSeen} (reader says ${s.updates}): v2 ${kinds.v2}, v3 ${kinds.v3}, v4 ${kinds.v4}.`,
    `Checks started ${checksStarted}: validated ${validated}, exact matches ${matches}, mismatches ${mismatches.length}, skipped (later event in same block) ${laterEvent}, ` +
      `unreadable ${unreadableTotal}${unreadable.size ? ' (' + [...unreadable.entries()].map(([k, n]) => `${k} x${n}`).join(', ') + ')' : ''}.`,
    ...mismatches.slice(0, 5).map((m) => `MISMATCH ${m}`),
    sel.solidlyLine,
  ]);
  process.exit(0);
})().catch((e) => {
  annotate('Block reader live check', [`Probe failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`]);
  process.exit(0);
});
