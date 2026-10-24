import { Wallet, keccak256 } from 'ethers';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeedMsg } from '../chains/nitroFeed';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, EntryDeps, EntryPick, entrySettings, rankRoutes, mergeRanked } from '../execution/trigEntry';
import {
  buildLoopIndexSteps, EntryLoopIndex, EntryLoop, LoopRules, pickLoops, loopQuoteUsd, LoopScoreMemo, CoinTaxFileView,
  EntryLoopSender, EntryLoopSendDeps, EntryLoopHost, loopIndexSettings, loopId,
} from '../execution/trigEntryLoops';
import { drainSteps } from '../core/chunked';
import { pickV3Lender, decodeExecuteCall } from '../execution/executorCalldata';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient } from '../execution/localSim';
import { SIM_EXECUTOR_ADDRESS } from '../execution/simulator';
import type { PoolState } from '../core/types';

// FIRE-FIRST ENTRY: 3-POOL LOOPS (execution/trigEntryLoops.ts + trigEntry.ts).
// Tests: loop enumeration (includes the moved pool, start coin held, venue /
// coin / tax rules, cap), lender never one of the loop's pools, ranking and
// merging with 2-pool candidates, a profitable loop reaching the sender with
// no waiting and no node request, every safeguard (incl. loop loss cap)
// stopping a send, shadow never sending, and the loop sender itself.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const A = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(20);
const USDG = A(1), WETH = A(2), X = A(3), Y = A(4), T = A(5), MEME = A(6);

// ---- a small pool universe ---------------------------------------------------
type P = { k: string; a: string; b: string; dex: string; depth: number };
const pUW: P = { k: A(0x11), a: USDG, b: WETH, dex: 'uni', depth: 100_000 };
const pWX: P = { k: A(0x12), a: WETH, b: X, dex: 'uni', depth: 50_000 };     // the moved pool
const pXU: P = { k: A(0x13), a: X, b: USDG, dex: 'uni', depth: 40_000 };
const pXU2: P = { k: A(0x14), a: USDG, b: X, dex: 'pancake', depth: 10_000 };
const pWY: P = { k: A(0x15), a: WETH, b: Y, dex: 'blocked-dex', depth: 90_000 }; // exchange not cleared
const pYU: P = { k: A(0x16), a: Y, b: USDG, dex: 'uni', depth: 90_000 };
const pWT: P = { k: A(0x17), a: WETH, b: T, dex: 'uni', depth: 90_000 };     // T: untested coin
const pTU: P = { k: A(0x18), a: T, b: USDG, dex: 'uni', depth: 90_000 };
const pWM: P = { k: A(0x19), a: WETH, b: MEME, dex: 'uni', depth: 90_000 };  // MEME: not on the allowed list
const pMU: P = { k: A(0x1a), a: MEME, b: USDG, dex: 'uni', depth: 90_000 };
const UNI = [pUW, pWX, pXU, pXU2, pWY, pYU, pWT, pTU, pWM, pMU];
const rulesOf = (o: { taxOk?: Set<string>; calls?: { n: number } } = {}): LoopRules<P> => ({
  key: (p) => p.k, tokens: (p) => [p.a, p.b],
  poolOk: (p) => { if (o.calls) o.calls.n++; return p.dex !== 'blocked-dex'; },
  coinOk: (t, isStart) => { if (o.calls) o.calls.n++; return t !== MEME && (isStart || t !== T || !!o.taxOk?.has(t)); },
  depth: (p) => p.depth,
});
const build = (pools: P[], r: LoopRules<P>, perPool = 50, maxLoops = 10_000) => drainSteps(buildLoopIndexSteps(pools, [USDG, WETH], r, { perPool, maxLoops }));

// ---- fakes for the entry point (same style as trigEntry.test.ts) ----------------
const walletA = new Wallet('0x' + '11'.repeat(32));
async function signed(nonce: number, to: string | null, data = '0x'): Promise<string> {
  return walletA.signTransaction({ type: 2, chainId: 4663, nonce, to, data, value: 0n, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
}
const msgOf = (seq: number, raws: string[]): FeedMsg => ({ seq, ts: 1_700_000_000 + seq, l1: 9000, complete: true, txs: raws.map((r) => ({ hash: keccak256(r), raw: r })) });
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const insufficient = (got: bigint) => '0x4e88422a' + word(got) + 'f'.repeat(64);
type Asked = Record<string, any>;
const EXECUTOR = '0x' + 'ee'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const PAIR_B = '0x' + 'b2'.repeat(20);

// Fake fast check: profit (start-coin units, $1 = 1e6) by the candidate's first route key.
function fakeSidecar(o: { pools?: string[]; profitFor?: (firstKey: string) => bigint; conf?: string } = {}) {
  const asked: Asked[] = [];
  const client = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Asked) => {
      asked.push(m);
      if (m.type === 'trig_discover') return { id: 1, ok: true, pools: o.pools ?? [pWX.k], conf: 'high', assumed: [] };
      if (m.type === 'call' && m.calls?.[0]?.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS) {
        const pf = o.profitFor?.((m.feed?.route ?? [])[0] ?? '') ?? 2_000_000n;
        const sizes = m.sizes ? (m.sizes.amounts as string[]).map((a) => ({ amount: a, status: 'profit', profit: '0x' + pf.toString(16), gasUsed: '0x1' })) : undefined;
        return { id: 1, ok: true, us: 500, results: [{ success: false, output: insufficient(pf), gasUsed: '0x5208' }],
          trig: { snapBlock: 100, included: false, triggerOk: true, msgs: 1, txs: 1, later: 0, lastSeq: 101, conf: o.conf ?? 'high', assumed: [] }, ...(sizes ? { sizes } : {}) };
      }
      return { id: 1, ok: false, unknown: 'bad_request' };
    },
  } as unknown as LocalSimClient;
  return { client, asked };
}
function fakeCopy2(): TrigCopy2 & { waits: number } {
  const c = {
    waits: 0, running: () => true, notReadyWhy: () => null,
    waitForTx: async () => { c.waits++; await sleep(2); return 101; },
    forwarder: { newestBlock: () => 100, txBlockOf: () => null },
  };
  return c;
}
const hop = (pool: string, i: string, o: string) => ({ kind: 1, pool, tokenIn: i, tokenOut: o, feeBps: 30 }) as any;
// A 3-pool loop candidate USDG -> WETH -> X -> USDG (USDG: $1 = 1e6 units).
// lender: the flash lender its check uses (null = own money; the fake fast
// check can't answer own-money balance questions, so entry tests use a lender).
function loopCand(label = 'loop USDG/WETH/X/USDG', score: number | null = 1, lender: string | null = LENDER): EntryCandidate {
  const keys = [pUW.k, pWX.k, pXU.k];
  const l: EntryLoop = { id: loopId(USDG, keys), start: USDG, keys: keys as any, tokens: [USDG, WETH, X], inIsA: [true, true, true], prio: 1 };
  const host: EntryLoopHost = { kind: 'loop', loop: l, base: USDG, usdPer: 1, dec: 6, coins: [USDG, WETH, X] };
  return {
    kind: 'loop', label, buyPool: pUW.k, sellPool: pXU.k, tokenIn: USDG, tokens: [USDG, WETH, X], keys: [...keys, ...(lender ? [lender] : [])],
    maxSizeUsd: 10_000, gasUsd: 0.07, failKey: [pUW.k, l.id], rank: { held: true, score },
    build: (usd) => ({ trade: { token: USDG, amountIn: BigInt(Math.round(usd * 1e6)), hops: [hop(pUW.k, USDG, WETH), hop(pWX.k, WETH, X), hop(pXU.k, X, USDG)] }, simOpts: lender ? { v3Lender: lender } : {} }),
    usdOf: (u) => Number(u) / 1e6, host,
  };
}
function pairCand(label = 'USDG/X uni>pancake', score: number | null = 0.5): EntryCandidate {
  return {
    label, buyPool: pXU.k, sellPool: PAIR_B, tokenIn: USDG, tokens: [USDG, X], keys: [pXU.k, PAIR_B], maxSizeUsd: 1_000, gasUsd: 0.05, rank: { held: true, score },
    build: (usd) => ({ trade: { token: USDG, amountIn: BigInt(Math.round(usd * 1e6)), hops: [hop(pXU.k, USDG, X), hop(PAIR_B, X, USDG)] }, simOpts: { v3Lender: LENDER } }),
    usdOf: (u) => Number(u) / 1e6,
  };
}

type Spies = { sends: EntryPick[]; sendWaits: number[]; loopAsks: Array<{ keys: string[]; limit: number }>; failKeys: string[][] };
function setup(o: { mode?: 'shadow' | 'on'; env?: Record<string, string>; sidecar?: ReturnType<typeof fakeSidecar>; pairs?: EntryCandidate[]; loops?: EntryCandidate[]; deps?: Partial<EntryDeps> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trigloops-'));
  const file = join(dir, 'shadow.jsonl');
  const log = new JsonlLog(file, 1_000_000, 0);
  const sc = o.sidecar ?? fakeSidecar();
  const c2 = fakeCopy2();
  const env = { LOCAL_SIM_TRIGGER_FIRST: o.mode ?? 'on', TRIG_ENTRY_ONE_TRIP: '0', ...(o.env ?? {}) };
  const tf = new TriggerFirst({ client: sc.client, settings: { ...trigFirstSettings(env), finalizeMs: 30, agreeWaitMs: 30 }, copy2: () => c2, shadowLog: log, hostOn: () => true, log: () => {} });
  const spies: Spies = { sends: [], sendWaits: [], loopAsks: [], failKeys: [] };
  const te = new TrigEntry({
    tf, client: sc.client, shadowLog: log, settings: { ...entrySettings(env, 0.25), deadlineMs: 2_000, discoverTimeoutMs: 500 },
    candidatesFor: (_k, limit) => { const all = o.pairs ?? []; return { cands: all.slice(0, limit), found: all.length }; },
    loopCandidatesFor: (keys, limit) => { spies.loopAsks.push({ keys, limit }); const all = o.loops ?? [loopCand()]; return { cands: all.slice(0, limit), found: all.length }; },
    loopGate: () => null,
    isOurTx: () => false, ourAddresses: [EXECUTOR],
    killed: () => false, safety: () => null, failBlocked: (a, b) => { spies.failKeys.push([a, b]); return null; }, pausedWhy: () => null,
    send: async (p) => { spies.sends.push(p); spies.sendWaits.push(c2.waits); return { signedMs: Date.now() }; },
    log: () => {},
    ...(o.deps ?? {}),
  });
  return { tf, te, log, file, sc, c2, spies };
}

// The loop sender's fakes (all counted, nothing real).
function senderOf(o: Partial<EntryLoopSendDeps> & { lossCap?: number } = {}) {
  const fired: string[] = [];
  const after: any[] = [];
  let t = 1_000_000;
  const d: EntryLoopSendDeps = {
    now: () => t, live: () => true, otherLossTodayUsd: () => 0, otherPaused: () => false, gasUsd: (f) => (f ? 0.09 : 0.07),
    isOutlier: () => false, safety: () => null, ready: () => null, deadline: () => 12_345n, executor: () => EXECUTOR, gasLimitOk: () => true,
    ownCovers: () => true, lenderOk: () => true, lenderFeePips: () => 100,
    fire: async (_to, data) => { fired.push(data); return { live: true, txHash: '0x' + String(fired.length).padStart(64, 'a'), signedAtMs: t }; },
    afterSent: (h, info) => { after.push({ h, ...info }); }, log: () => {}, dayOf: () => 'd1', ...o,
  };
  const s = new EntryLoopSender({ lossCapUsd: o.lossCap ?? 2, maxTradeUsd: 10_000, blockMs: 30 * 60_000 }, d);
  return { s, fired, after, tick: (ms: number) => { t += ms; } };
}
const pickOf = (c: EntryCandidate, sizeUsd = 400, net = 1.5): EntryPick => {
  const b = c.build(sizeUsd)!;
  return { cand: c, sizeUsd, amountIn: b.trade.amountIn, profitUnits: 1n, netUsd: net, out: { sure: true, confidence: 'high', assumptions: [] } as any, q: { trade: b.trade, simOpts: b.simOpts, triggerHash: '0x1', seenMs: 0, keys: c.keys, label: c.label } };
};

// The plain execute call (own money) decodes with decodeExecuteCall; the flash one doesn't.
const after0 = (data: string) => { try { decodeExecuteCall(data); return false; } catch { return true; } };

async function main() {
  // ---- settings ------------------------------------------------------------------
  {
    const s = entrySettings({}, 0.25);
    assert(s.loops === true && s.maxLoops === 4, 'defaults: TRIG_ENTRY_LOOPS on, TRIG_ENTRY_MAX_LOOPS 4');
    assert(entrySettings({ TRIG_ENTRY_LOOPS: '0' }).loops === false, 'TRIG_ENTRY_LOOPS=0 switches loops off');
    const li = loopIndexSettings({});
    assert(li.perPool === 24 && li.maxLoops === 20_000 && li.checkMs === 10_000 && li.rebuildMs === 60_000, 'loop index defaults: 24 per pool, 20,000 total, checked every 10 s, rebuilt at least every 60 s');
  }

  // ---- enumeration ----------------------------------------------------------------
  {
    const d = build(UNI, rulesOf());
    const forMoved = d.byPool.get(pWX.k) ?? [];
    assert(forMoved.length > 0 && forMoved.every((l) => l.keys.includes(pWX.k)), `every loop listed for the moved pool goes through it (${forMoved.length})`);
    assert(forMoved.every((l) => l.start === USDG || l.start === WETH), 'every loop starts (and ends) in a coin we hold (USDG / WETH)');
    assert(forMoved.every((l) => new Set(l.keys).size === 3 && new Set(l.tokens).size === 3), 'three different pools and three different coins');
    // Chain check: each hop's coin out is the next hop's coin in, back to the start.
    const P = new Map(UNI.map((p) => [p.k, p]));
    const chains = forMoved.every((l) => l.keys.every((k, i) => { const p = P.get(k)!; const tin = l.tokens[i], tout = l.tokens[(i + 1) % 3]; return (l.inIsA[i] ? p.a === tin && p.b === tout : p.b === tin && p.a === tout); }));
    assert(chains, 'each loop chains: coin out of one pool is the coin into the next, ending in the start coin (direction flags right)');
    const ids = forMoved.map((l) => l.id);
    const want = [loopId(USDG, [pUW.k, pWX.k, pXU.k]), loopId(USDG, [pXU.k, pWX.k, pUW.k]), loopId(WETH, [pWX.k, pXU.k, pUW.k]), loopId(USDG, [pUW.k, pWX.k, pXU2.k])];
    assert(want.every((w) => ids.includes(w)), 'both directions, both start coins, and the same pair on another exchange as the 3rd pool');
    assert(ids.length === new Set(ids).size, 'each loop listed once per pool');
    const all = [...d.byPool.values()].flat();
    assert(!all.some((l) => l.keys.includes(pWY.k)), 'an exchange not cleared for trading: no loop through it (venue rule)');
    assert(!all.some((l) => l.tokens.includes(MEME)), 'a coin not on the allowed list: no loop through it (coin rule)');
    assert(!all.some((l) => l.tokens.includes(T)), 'a middle coin that has not passed the tax test: no loop through it');
    const d2 = build(UNI, rulesOf({ taxOk: new Set([T]) }));
    assert([...d2.byPool.values()].flat().some((l) => l.tokens.includes(T)), 'once it passed the tax test: its loops appear');
    // Cap per pool (deepest first) and total cap.
    const d3 = build(UNI, rulesOf(), 2);
    const top = d3.byPool.get(pWX.k)!;
    assert(top.length === 2 && top[0].prio >= top[1].prio && !top.some((l) => l.keys.includes(pXU2.k)), 'per-pool cap keeps the deepest loops (the shallow 3rd pool left out first)');
    const d4 = build(UNI, rulesOf(), 50, 3);
    assert(d4.loops === 3 && d4.capped, 'total cap (TRIG_ENTRY_LOOP_INDEX_MAX) respected and reported');
  }

  // ---- lender is never one of the loop's pools ----------------------------------------
  {
    const v3 = (addr: string, a: string, b: string, feeBps: number) => ({ chain: 'robinhood', dex: 'uniswap-v3', poolType: 'v3', poolAddress: addr, tokenA: a, tokenB: b, feeBps, liquidity: 10n ** 20n }) as unknown as PoolState;
    const routeLender = v3(pUW.k, USDG, WETH, 1);   // cheapest lender, but it is the loop's first pool
    const other = v3(LENDER, USDG, X, 5);
    const loopPools = [pUW.k, pWX.k, pXU.k];
    const picked = pickV3Lender([routeLender, other], USDG, loopPools);
    assert(picked?.poolAddress === LENDER, 'the cheapest lender is one of the loop\'s pools: the next one is used (lender exclusion over all 3 pools)');
    assert(pickV3Lender([routeLender], USDG, loopPools) === null, 'no lender outside the loop: none (the loop then runs on own money or not at all)');
  }

  // ---- per trigger: lookup, ranking, cap, no rule calls -----------------------------------
  {
    const calls = { n: 0 };
    const d = build(UNI, rulesOf({ calls }));
    const before = calls.n;
    const r = pickLoops([pWX.k, pXU.k], (k) => d.byPool.get(k) ?? [], () => true, (l) => (l.keys[2] === pXU2.k ? 5 : 1), 2, rankRoutes);
    assert(r.found === new Set([...(d.byPool.get(pWX.k) ?? []), ...(d.byPool.get(pXU.k) ?? [])].map((l) => l.id)).size, 'loops through any moved pool, each counted once (found before the cap)');
    assert(r.loops.length === 2 && r.loops[0].keys[2] === pXU2.k, 'ranked by the quick price check and capped (TRIG_ENTRY_MAX_LOOPS)');
    assert(calls.n === before, 'a trigger only READS the index: no pool / coin rule is evaluated per trigger (rules run in the rebuild only)');
    assert(pickLoops([A(0x77)], (k) => d.byPool.get(k) ?? [], () => true, () => 1, 4, rankRoutes).loops.length === 0, 'a moved pool with no loops: none');
  }

  // ---- quick price check + memo ---------------------------------------------------------
  {
    const v2 = (addr: string, a: string, b: string, ra: bigint, rb: bigint) => ({ chain: 'robinhood', dex: 'x', poolType: 'v2', poolAddress: addr, tokenA: a, tokenB: b, reserveA: ra, reserveB: rb, feeBps: 30, feePips: 3000 }) as unknown as PoolState;
    const s1 = v2(pUW.k, USDG, WETH, 1_000_000n * 10n ** 6n, 500n * 10n ** 18n);      // 1 WETH = 2000 USDG
    const s2 = v2(pWX.k, WETH, X, 500n * 10n ** 18n, 1_000_000n * 10n ** 18n);       // 1 WETH = 2000 X
    const s3 = v2(pXU.k, X, USDG, 1_000_000n * 10n ** 18n, 1_100_000n * 10n ** 6n);  // 1 X = 1.10 USDG (cheap X)
    const q = loopQuoteUsd([s1, s2, s3], [true, true, true], 50, 1, 6);
    assert(q !== null && q > 3 && q < 5, `quick price check of a loop ($50 in, X priced 10% low on the last pool): +$${q?.toFixed(2)}`);
    const memo = new LoopScoreMemo();
    let runs = 0;
    const f = () => { runs++; return 1; };
    memo.get('l', [s1, s2, s3], 1, f); memo.get('l', [s1, s2, s3], 1, f);
    assert(runs === 1 && memo.hits === 1, 'remembered while the 3 pool states and the price are the same');
    memo.get('l', [s1, { ...s2 }, s3], 1, f);
    assert(runs === 2, 'a replaced pool state: priced again');
  }

  // ---- coin tax results (read-only file) ---------------------------------------------------
  {
    const dir = mkdtempSync(join(tmpdir(), 'cointax-'));
    const f = join(dir, 'coin-tax.json');
    const now = 10 * 3600_000;
    writeFileSync(f, JSON.stringify({ version: 1, coins: { [X]: { v: 'ok', at: now - 3600_000 }, [Y]: { v: 'ok', at: now - 7 * 3600_000 }, [T]: { v: 'taxed', at: now - 30 * 3600_000 } } }));
    const v = new CoinTaxFileView(f, 6 * 3600_000, () => now);
    v.refresh();
    assert(v.verdict(X) === 'ok' && v.verdict(Y) === undefined && v.verdict(T) === 'taxed' && v.verdict(MEME) === undefined, 'tax file: fresh pass = ok, pass older than 6 h = not tested, taxed stays taxed, unknown = not tested');
    const none = new CoinTaxFileView(join(dir, 'missing.json'));
    none.refresh();
    assert(none.verdict(X) === undefined, 'no tax file yet: nothing counts as passed (no loops through untested coins)');
  }

  // ---- index rebuilds only when the pool set changes (or it is old) ------------------------
  {
    let pools = UNI.slice(0, 4);
    let t = 0;
    const idx = new EntryLoopIndex<P>({ ...loopIndexSettings({}), rebuildMs: 60_000 }, { pools: () => pools, startCoins: [USDG, WETH], rules: () => rulesOf(), now: () => t });
    assert(await idx.maybeRebuild(), 'first build');
    assert(idx.loopsFor(pWX.k).length > 0, 'loops available after the build');
    assert(!(await idx.maybeRebuild()), 'same pools, fresh index: not rebuilt');
    pools = UNI.slice(0, 3);
    assert(await idx.maybeRebuild(), 'a pool left: rebuilt');
    assert(idx.loopsFor(pXU2.k).length === 0, 'its loops are gone');
    t += 61_000;
    assert(await idx.maybeRebuild(), 'older than the rebuild time: rebuilt anyway (new tax results / coin rules are picked up)');
  }

  // ---- merge with 2-pool candidates --------------------------------------------------------
  {
    const p1 = pairCand('p1', 2), p2 = pairCand('p2', 0.1), l1 = loopCand('l1', 1), l2 = loopCand('l2', null);
    assert(mergeRanked([p1, p2], [l1, l2]).map((c) => c.label).join() === 'p1,l1,p2,l2', 'merged in rank order (better quick check first, unknown last)');
    const tie = mergeRanked([pairCand('p', 1)], [loopCand('l', 1)]);
    assert(tie[0].label === 'p', 'a tie keeps the 2-pool candidate first');
    const notHeld = { ...pairCand('ph', 9), rank: { held: false, score: 9 } };
    assert(mergeRanked([notHeld], [loopCand('l', 0)])[0].label === 'l', 'a start coin we hold beats a better price on a coin we don\'t hold');
  }

  const swapData = '0x12345678' + '00'.repeat(32);
  const tSwap = await signed(0, pWX.k, swapData);
  const msgs = [msgOf(100, []), msgOf(101, [tSwap])];
  const hash = keccak256(tSwap).toLowerCase();

  // ---- ON: a profitable loop reaches the sender with no waiting and no node -----------------
  {
    const { tf, te, sc, spies, c2 } = setup({ mode: 'on', env: { TRIG_ENTRY_PARALLEL: '1' }, pairs: [pairCand('pair', 0.1)], sidecar: fakeSidecar({ profitFor: (k) => (k === pUW.k ? 2_000_000n : 0n) }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.loopAsks.length === 1 && spies.loopAsks[0].keys.join() === pWX.k && spies.loopAsks[0].limit === 4, 'the moved pool goes to the loop builder with the loop cap (TRIG_ENTRY_MAX_LOOPS)');
    assert(spies.sends.length === 1 && spies.sends[0].cand.kind === 'loop', 'on: the profitable loop is sent');
    assert(spies.sendWaits[0] === 0, 'sent WITHOUT waiting for the trigger\'s pool reports');
    const checks = sc.asked.filter((m) => m.type === 'call');
    assert(sc.asked.every((m) => m.type === 'trig_discover' || (m.type === 'call' && !!m.feed)), 'only fast-check questions on the replayed feed: no receipt polling, no node request');
    assert(checks[0].feed.route.slice(0, 3).join() === [pUW.k, pWX.k, pXU.k].join() && checks[0].feed.route[3] === LENDER, 'the loop ranked first is checked first, on the replayed feed with its 3 pools (+ its lender) as the route');
    const sent = spies.sends[0];
    assert(sent.q.trade.hops.length === 3 && sent.netUsd > 0.25, 'our exact 3-hop trade was checked and is what is handed to the sender');
    assert(spies.failKeys.some((k) => k[0] === pUW.k && k[1] === loopId(USDG, [pUW.k, pWX.k, pXU.k])), 'the 30-min fail block is asked about THIS loop (first pool + loop id)');
    assert(rec!.cv![0].k === 'loop' && rec!.foundLoops === 1 && rec!.loops === 1 && rec!.best?.kind === 'loop' && rec!.early === true, 'each checked candidate says its kind; loops found / built; best = loop; the good loop answer stopped the rest');
    const hour = te.takeHourLine() ?? '';
    assert(/by kind .*: pair 1\/0\/0\/0\/0, loop 1\/1\/1\/1\/1/.test(hour), `hourly split by kind: ${hour.match(/by kind[^;]*/)?.[0]}`);
  }
  {
    const { tf, te, spies } = setup({ mode: 'on', env: { TRIG_ENTRY_LOOPS: '0' }, pairs: [pairCand()] });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.loopAsks.length === 0 && spies.sends[0]?.cand.kind === undefined && rec!.foundLoops === undefined, 'TRIG_ENTRY_LOOPS=0: loops never asked for, 2-pool path unchanged');
  }
  {
    const many = [1, 2, 3, 4, 5, 6].map((i) => loopCand(`l${i}`, i));
    const { tf, te, sc } = setup({ mode: 'shadow', loops: many, env: { TRIG_ENTRY_MAX_LOOPS: '2' }, sidecar: fakeSidecar({ profitFor: () => 0n }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(rec!.loops === 2 && rec!.foundLoops === 6 && sc.asked.filter((m) => m.type === 'call').length === 2, 'loop candidates capped separately (TRIG_ENTRY_MAX_LOOPS=2)');
  }

  // ---- ON: every safeguard stops a loop send ---------------------------------------------------
  const blockedBy = async (name: string, o: Parameters<typeof setup>[0], re: RegExp) => {
    const { tf, te, spies } = setup({ mode: 'on', ...o });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.sends.length === 0 && re.test(rec?.held ?? ''), `${name}: loop not sent (${rec?.held})`);
  };
  await blockedBy('kill file', { deps: { killed: () => true } }, /kill switch/);
  await blockedBy('SafetyGate', { deps: { safety: () => 'daily loss cap reached' } }, /safety: daily loss cap/);
  await blockedBy('30-min fail block on this loop', { deps: { failBlocked: (_a, b) => (b.startsWith('loop:') ? 'live trade failed on chain' : null) } }, /loop blocked 30 min/);
  await blockedBy('scoreboard pause', { deps: { pausedWhy: () => 'trig_first high paused' } }, /scoreboard/);
  await blockedBy('loop loss cap', { deps: { loopGate: () => 'loop loss cap (counting trades in flight)' } }, /loop: loop loss cap/);
  await blockedBy('no loop sender wired', { deps: { loopGate: undefined } }, /loop: no loop sender/);
  await blockedBy('confidence floor', { sidecar: fakeSidecar({ conf: 'medium' }), env: { TRIG_FIRST_MIN_CONFIDENCE: 'high' } }, /confidence medium below high/);
  {
    const { tf, te, spies } = setup({ mode: 'on', sidecar: fakeSidecar({ profitFor: () => 200_000n }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.sends.length === 0 && !rec!.wouldSend, 'under the send minimum ($0.20 - gas): loop not sent');
  }
  {
    const { tf, te, spies } = setup({ mode: 'on' });
    tf.onFeedMsgs(msgs, Date.now());
    assert(te.claim(hash, 'old'), 'the old path claims the trigger first');
    const rec = await te.process(hash, Date.now());
    assert(spies.sends.length === 0 && /already sent by the old path/.test(rec!.held ?? ''), 'one send per trigger: the loop is not sent too');
  }

  // ---- SHADOW never sends ------------------------------------------------------------------------
  {
    const { tf, te, spies, file, log } = setup({ mode: 'shadow' });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.sends.length === 0 && rec!.wouldSend === true, 'shadow: a profitable loop is "would send", never sent');
    await sleep(120);
    await log.flush();
    const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const l = lines.find((x) => x.k === 'trig_entry');
    assert(!!l && l.fl === 1 && l.nl === 1 && l.bk === 'loop' && Array.isArray(l.cv) && l.cv[0].k === 'loop' && l.would === true, 'log line: loops found / built, best kind, cv kind');
  }

  // ---- the loop sender ---------------------------------------------------------------------------------
  {
    const { s, fired, after } = senderOf();
    const p = pickOf(loopCand('own', 1, null));
    assert(s.gate(p) === null, 'loop gate: all fine');
    const r = await s.send(p, { hash: '0x1', seenMs: 0 });
    assert(r.signedMs !== undefined && fired.length === 1 && after.length === 1, 'own money: sent, bookkeeping done');
    const dec = decodeExecuteCall(fired[0]);
    assert(dec[0].hops.length === 3 && dec[0].amountIn === p.amountIn && dec[0].minProfit === 1_500_000n && dec[0].maxBlock === 12_345n, 'the contract call: our 3 hops, the checked size, profit floor = the checked net after gas, deadline');
    assert(after[0].failKey[1].startsWith('loop:') && after[0].poolKeys.length === 3, 'bookkeeping gets the loop\'s fail-block keys and pools');
    assert(/in flight/.test(s.gate(pickOf(loopCand())) ?? ''), 'a loop on the same pools still in flight: the next one waits');
    s.noteResult({ hash: '0x' + '1'.padStart(64, 'a'), status: 'reverted', gasUsd: 0.5 });
    assert(/failed on chain recently/.test(s.gate(pickOf(loopCand())) ?? ''), 'a loop that failed on chain: not sent again for 30 min');
    assert(s.lossTodayUsd() === 0.5, 'its gas counts toward the loop loss cap');
  }
  {
    const { s } = senderOf({ otherLossTodayUsd: () => 1.95 });
    assert(/loop loss cap/.test(s.gate(pickOf(loopCand())) ?? ''), 'loop loss cap: the live loop sender\'s losses count too (shared cap)');
    const { s: s2 } = senderOf({ otherPaused: () => true });
    assert(/loss cap reached today/.test(s2.gate(pickOf(loopCand())) ?? ''), 'live loops paused today: fire-first loops paused too');
    const { s: s3 } = senderOf();
    assert(/over the loop size limit/.test(s3.gate(pickOf(loopCand(), 20_000)) ?? ''), 'loop size limit ($10,000)');
  }
  {
    const { s, after } = senderOf({ alert: () => {} });
    const r1 = await s.send(pickOf(loopCand()), { hash: '0x1', seenMs: 0 });
    s.noteResult({ hash: after[0].h, status: 'reverted', gasUsd: 2.1 });
    assert(r1.signedMs !== undefined && s.pausedToday() && /loss cap reached today/.test(s.gate(pickOf(loopCand('other'))) ?? ''), 'gas lost over the cap: fire-first loops paused for the day');
  }
  {
    const { s, fired } = senderOf();
    const r = await s.send(pickOf(loopCand('flash', 1, LENDER)), { hash: '0x1', seenMs: 0 });
    assert(r.signedMs !== undefined && fired[0].toLowerCase().includes(LENDER.slice(2)) && after0(fired[0]), 'flash loan: sent with the lender the check used (flash call carries that lender)');
  }
  {
    const { s, fired } = senderOf({ ownCovers: () => false });
    const r = await s.send(pickOf(loopCand('own', 1, null)), { hash: '0x1', seenMs: 0 });
    assert(fired.length === 0 && /own money too low/.test(r.why ?? ''), 'live, own money no longer covers the loop: not sent');
    const { s: s2, fired: f2 } = senderOf({ lenderOk: () => false });
    const r2 = await s2.send(pickOf(loopCand('f', 1, LENDER)), { hash: '0x1', seenMs: 0 });
    assert(f2.length === 0 && /lender no longer holds enough/.test(r2.why ?? ''), 'live, the lender no longer holds enough: not sent');
    const { s: s3, fired: f3 } = senderOf({ isOutlier: () => true });
    assert((await s3.send(pickOf(loopCand()), { hash: '0x1', seenMs: 0 })).why?.includes('outlier') && f3.length === 0, 'outlier guard: not sent');
    const { s: s4, fired: f4 } = senderOf({ deadline: () => null });
    assert((await s4.send(pickOf(loopCand()), { hash: '0x1', seenMs: 0 })).why === 'block info stale' && f4.length === 0, 'no fresh block number: not sent');
  }

  // ---- CPU (TEST NUMBERS ONLY): index build and per-trigger lookup on a bigger universe --------------
  {
    const coins = Array.from({ length: 60 }, (_, i) => '0x' + (1000 + i).toString(16).padStart(40, '0'));
    const big: P[] = [];
    let n = 0x1000;
    for (const c of coins) { big.push({ k: '0x' + (n++).toString(16).padStart(40, '0'), a: USDG, b: c, dex: 'uni', depth: 1e5 }); big.push({ k: '0x' + (n++).toString(16).padStart(40, '0'), a: WETH, b: c, dex: 'uni', depth: 1e5 }); }
    for (let i = 0; i < 120; i++) big.push({ k: '0x' + (n++).toString(16).padStart(40, '0'), a: coins[i % 60], b: coins[(i * 7 + 3) % 60], dex: 'uni', depth: 1e4 });
    big.push(pUW);
    const r: LoopRules<P> = { key: (p) => p.k, tokens: (p) => [p.a, p.b], poolOk: () => true, coinOk: () => true, depth: (p) => p.depth };
    const t0 = performance.now();
    const d = build(big, r, 24, 20_000);
    const ms = performance.now() - t0;
    const keys = big.slice(0, 50).map((p) => p.k);
    const t1 = performance.now();
    let picked = 0;
    for (const k of keys) picked += pickLoops([k], (x) => d.byPool.get(x) ?? [], () => true, () => 1, 4, rankRoutes).loops.length;
    const per = (performance.now() - t1) / keys.length;
    console.log(`[bench, test numbers only] loop index: ${big.length} pools -> ${d.loops} loops in ${ms.toFixed(1)} ms (built in bites in the bot); per trigger lookup+rank ${per.toFixed(3)} ms`);
    assert(d.loops > 500 && picked === keys.length * 4 && per < 2, 'index lists hundreds of loops; a trigger\'s lookup + rank is well under 2 ms');
  }
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
