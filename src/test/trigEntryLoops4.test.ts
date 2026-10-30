import { Interface } from 'ethers';
import {
  buildLoopIndexSteps, EntryLoopIndex, EntryLoop, LoopRules, LoopBuildOpts, EntryLoopSender, EntryLoopSendDeps, EntryLoopHost,
  loopIndexSettings, loopId, pickLoops,
} from '../execution/trigEntryLoops';
import { EntryCandidate, EntryPick, rankRoutes } from '../execution/trigEntry';
import { drainSteps } from '../core/chunked';
import { pickV3Lender, decodeExecuteCall, EXECUTE_ABI } from '../execution/executorCalldata';
import { loopGasUnits, loopGasUsd } from '../core/loopTrader';
import type { PoolState } from '../core/types';

// FIRE-FIRST ENTRY: 4-POOL LOOPS (Oct 25, execution/trigEntryLoops.ts).
//
// Plain English: live today a rival bot earned ~$11-13 repeating the loop
// WETH -> PONS -> DJT -> USDG -> WETH. Our loop index only held 3-pool
// loops. These tests build a small fake pool set containing that cycle and
// check:
//   (a) by default (TRIG_ENTRY_LOOP_POOLS_MAX unset = 3) no 4-pool loops;
//   (b) with TRIG_ENTRY_LOOP_POOLS_MAX=4 the loop is listed under each of
//       its 4 pools, in both directions, from both coins we hold;
//   (c) a middle coin that hasn't passed the tax test, or an exchange not
//       cleared for trading, keeps a loop out;
//   (d) the flash lender is never one of the loop's 4 pools;
//   (e) a 4-hop loop's gas is higher than a 3-hop loop's, and the sender's
//       loss-cap check uses the 4-pool figure;
//   (f) per-pool caps (TRIG_ENTRY_LOOPS4_PER_POOL), the whole-index cap and
//       the per-coin cap hold, and 3-pool loops are never pushed out;
//   (g) the contract call carries the 4 hops in the right order (own money
//       and flash loan);
// plus a CPU number for a ~1,200-pool set (test machine only).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(20);
const USDG = A(1), WETH = A(2), PONS = A(3), DJT = A(4), TAXY = A(5);

// ---- the fake pool set (same shape as trigEntryLoops.test.ts) ---------------------
type P = { k: string; a: string; b: string; dex: string; depth: number };
const pWP: P = { k: A(0x21), a: WETH, b: PONS, dex: 'uni', depth: 50_000 };
const pPD: P = { k: A(0x22), a: PONS, b: DJT, dex: 'uni', depth: 40_000 };   // the moved pool
const pDU: P = { k: A(0x23), a: DJT, b: USDG, dex: 'uni', depth: 30_000 };
const pUW: P = { k: A(0x24), a: USDG, b: WETH, dex: 'uni', depth: 100_000 };
const pDU2: P = { k: A(0x25), a: USDG, b: DJT, dex: 'blocked-dex', depth: 90_000 }; // exchange not cleared
const pPT: P = { k: A(0x26), a: PONS, b: TAXY, dex: 'uni', depth: 90_000 };         // TAXY: untested coin
const pTU: P = { k: A(0x27), a: TAXY, b: USDG, dex: 'uni', depth: 90_000 };
const UNI = [pWP, pPD, pDU, pUW, pDU2, pPT, pTU];
const CYCLE = [pWP, pPD, pDU, pUW];

const rulesOf = (o: { taxOk?: Set<string> } = {}): LoopRules<P> => ({
  key: (p) => p.k, tokens: (p) => [p.a, p.b],
  poolOk: (p) => p.dex !== 'blocked-dex',
  coinOk: (t, isStart) => isStart || t !== TAXY || !!o.taxOk?.has(t),
  depth: (p) => p.depth,
});
const build = (pools: P[], r: LoopRules<P>, o: Partial<LoopBuildOpts> = {}) =>
  drainSteps(buildLoopIndexSteps(pools, [USDG, WETH], r, { perPool: 24, maxLoops: 20_000, ...o }));
const on4 = (o: Partial<LoopBuildOpts> = {}) => ({ ...loopIndexSettings({ TRIG_ENTRY_LOOP_POOLS_MAX: '4' }), ...o });

// The 4 ways round the rival's cycle: from WETH and from USDG, both directions.
const RIVAL_IDS = [
  loopId(WETH, [pWP.k, pPD.k, pDU.k, pUW.k]),   // WETH -> PONS -> DJT -> USDG -> WETH (the rival's)
  loopId(WETH, [pUW.k, pDU.k, pPD.k, pWP.k]),   // WETH -> USDG -> DJT -> PONS -> WETH (reverse)
  loopId(USDG, [pUW.k, pWP.k, pPD.k, pDU.k]),   // USDG -> WETH -> PONS -> DJT -> USDG
  loopId(USDG, [pDU.k, pPD.k, pWP.k, pUW.k]),   // USDG -> DJT -> PONS -> WETH -> USDG
];

// Each hop's coin out is the next hop's coin in, back to the start; direction flags right.
const PM = new Map(UNI.map((p) => [p.k, p]));
const chains = (l: EntryLoop, pm: Map<string, P> = PM) => l.keys.length === l.tokens.length && l.inIsA.length === l.keys.length && l.keys.every((k, i) => {
  const p = pm.get(k)!; const tin = l.tokens[i], tout = l.tokens[(i + 1) % l.keys.length];
  return l.inIsA[i] ? p.a === tin && p.b === tout : p.b === tin && p.a === tout;
});

// ---- the loop sender's fakes (nothing real) ---------------------------------------------
const EXECUTOR = '0x' + 'ee'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
function senderOf(o: Partial<EntryLoopSendDeps> & { lossCap?: number } = {}) {
  const fired: string[] = [];
  const gasAsks: Array<number | undefined> = [];
  const t = 1_000_000;
  const d: EntryLoopSendDeps = {
    now: () => t, live: () => true, otherLossTodayUsd: () => 0, otherPaused: () => false,
    gasUsd: (f, pools) => { gasAsks.push(pools); return (f ? 0.09 : 0.07) * (loopGasUnits(pools ?? 3) / loopGasUnits(3)); },
    isOutlier: () => false, safety: () => null, ready: () => null, deadline: () => 12_345n, executor: () => EXECUTOR, gasLimitOk: () => true,
    ownCovers: () => true, lenderOk: () => true, lenderFeePips: () => 100,
    fire: async (_to, data) => { fired.push(data); return { live: true, txHash: '0x' + String(fired.length).padStart(64, 'a'), signedAtMs: t }; },
    afterSent: () => {}, log: () => {}, dayOf: () => 'd1', ...o,
  };
  const s = new EntryLoopSender({ lossCapUsd: o.lossCap ?? 2, maxTradeUsd: 10_000, blockMs: 30 * 60_000 }, d);
  return { s, fired, gasAsks };
}
// A 4-pool loop candidate built the way shadowMain.ts builds the hops
// (tokenOut = the next coin, wrapping round to the start).
const hopOf = (pool: string, i: string, o: string) => ({ kind: 1, pool, tokenIn: i, tokenOut: o, feeBps: 30 }) as any;
function loop4Cand(l: EntryLoop, lender: string | null): EntryCandidate {
  const host: EntryLoopHost = { kind: 'loop', loop: l, base: l.start, usdPer: 1, dec: 6, coins: [...new Set(l.tokens)] };
  const hops = l.keys.map((k, i) => hopOf(k, l.tokens[i], l.tokens[(i + 1) % l.keys.length]));
  return {
    kind: 'loop', label: 'loop4', buyPool: l.keys[0], sellPool: l.keys[l.keys.length - 1], tokenIn: l.start, tokens: host.coins,
    keys: [...l.keys, ...(lender ? [lender] : [])], maxSizeUsd: 10_000, gasUsd: 0.1, failKey: [l.keys[0], l.id], rank: { held: true, score: 1 },
    build: (usd) => ({ trade: { token: l.start, amountIn: BigInt(Math.round(usd * 1e6)), hops }, simOpts: lender ? { v3Lender: lender } : {} }),
    usdOf: (u) => Number(u) / 1e6, host,
  };
}
const pickOf = (c: EntryCandidate, sizeUsd = 400, net = 1.5): EntryPick => {
  const b = c.build(sizeUsd)!;
  return { cand: c, sizeUsd, amountIn: b.trade.amountIn, profitUnits: 1n, netUsd: net, out: { sure: true, confidence: 'high', assumptions: [] } as any, q: { trade: b.trade, simOpts: b.simOpts, triggerHash: '0x1', seenMs: 0, keys: c.keys, label: c.label } };
};

async function main() {
  // ---- settings ---------------------------------------------------------------------
  {
    const d = loopIndexSettings({});
    assert(d.poolsMax === 3 && d.perPool4 === 8 && d.perPool === 24 && d.maxLoops === 20_000, 'defaults: TRIG_ENTRY_LOOP_POOLS_MAX 3 (4-pool loops off), TRIG_ENTRY_LOOPS4_PER_POOL 8, 3-pool settings unchanged');
    assert(loopIndexSettings({ TRIG_ENTRY_LOOP_POOLS_MAX: '4' }).poolsMax === 4, 'TRIG_ENTRY_LOOP_POOLS_MAX=4 switches 4-pool loops on');
    // Oct 26: 5-pool loops added, so the top is now 5 (see trigEntryLoops5.test.ts).
    assert(loopIndexSettings({ TRIG_ENTRY_LOOP_POOLS_MAX: '9' }).poolsMax === 5 && loopIndexSettings({ TRIG_ENTRY_LOOP_POOLS_MAX: '2' }).poolsMax === 3 && loopIndexSettings({ TRIG_ENTRY_LOOP_POOLS_MAX: 'x' }).poolsMax === 3, 'only 3, 4 or 5: higher means 5, lower or not a number means 3');
    assert(loopIndexSettings({ TRIG_ENTRY_LOOPS4_PER_POOL: '3' }).perPool4 === 3, 'TRIG_ENTRY_LOOPS4_PER_POOL read');
  }

  // ---- (a) default: no 4-pool loops ------------------------------------------------------
  {
    const d = build(UNI, rulesOf(), loopIndexSettings({}));
    const all = [...d.byPool.values()].flat();
    assert(all.every((l) => l.keys.length === 3) && !d.loops4, `default: no 4-pool loops in the index (${all.length} 3-pool listings)`);
    assert((d.byPool.get(pPD.k) ?? []).length === 0, 'default: the rival\'s middle pool (PONS/DJT) has no loops at all, exactly as before');
    const d3 = build(UNI, rulesOf());
    assert(JSON.stringify([...d.byPool.entries()]) === JSON.stringify([...d3.byPool.entries()]) && d.loops === d3.loops, 'default build is identical to the old 3-pool-only build');
  }

  // ---- (b) TRIG_ENTRY_LOOP_POOLS_MAX=4: the rival's loop for each of its pools ------------
  {
    const d = build(UNI, rulesOf(), on4());
    for (const p of CYCLE) {
      const ids = (d.byPool.get(p.k) ?? []).map((l) => l.id);
      assert(RIVAL_IDS.every((w) => ids.includes(w)), `pool ${p.a === WETH && p.b === PONS ? 'WETH/PONS' : p.a === PONS ? 'PONS/DJT' : p.a === DJT ? 'DJT/USDG' : 'USDG/WETH'}: the loop listed both directions, from WETH and from USDG`);
    }
    const four = [...d.byPool.values()].flat().filter((l) => l.keys.length === 4);
    assert(four.length > 0 && four.every((l) => chains(l)), 'every 4-pool loop chains (coin out of one pool = coin into the next, back to the start; direction flags right)');
    assert(four.every((l) => new Set(l.keys).size === 4 && new Set(l.tokens).size === 4), 'four different pools and four different coins');
    assert(four.every((l) => l.start === USDG || l.start === WETH), 'every 4-pool loop starts (and ends) in a coin we hold');
    const ids = (d.byPool.get(pPD.k) ?? []).map((l) => l.id);
    assert(ids.length === new Set(ids).size, 'each loop listed once per pool');
    assert(d.loops4 === 4 && d.loops === d.loops4 + build(UNI, rulesOf()).loops, `count reported: ${d.loops4} 4-pool loops, total = 3-pool + 4-pool`);
    // Through the real index class, with the setting from the environment.
    const idx = new EntryLoopIndex<P>(loopIndexSettings({ TRIG_ENTRY_LOOP_POOLS_MAX: '4' }), { pools: () => UNI, startCoins: [USDG, WETH], rules: () => rulesOf() });
    await idx.maybeRebuild(true);
    assert(RIVAL_IDS.every((w) => idx.loopsFor(pPD.k).some((l) => l.id === w)) && idx.info().loops4 === 4, 'the loop index (bites, as in the bot) holds them too; info() reports the 4-pool count');
    const r = pickLoops([pPD.k], (k) => idx.loopsFor(k), () => true, () => 1, 4, rankRoutes);
    assert(r.found === 4 && r.loops.length === 4, 'a trigger moving PONS/DJT now finds the rival\'s loop (4 ways round)');
  }

  // ---- (c) untested middle coin / exchange not cleared ------------------------------------
  {
    const d = build(UNI, rulesOf(), on4());
    const all = [...d.byPool.values()].flat();
    assert(!all.some((l) => l.tokens.includes(TAXY)), 'a middle coin that has not passed the tax test: no 4-pool loop through it');
    assert(!all.some((l) => l.keys.includes(pDU2.k)), 'an exchange not cleared for trading: no 4-pool loop through it (even though deeper)');
    const d2 = build(UNI, rulesOf({ taxOk: new Set([TAXY]) }), on4());
    const viaT = [...d2.byPool.values()].flat().filter((l) => l.tokens.includes(TAXY));
    assert(viaT.length > 0 && viaT.every((l) => l.keys.length === 4 && chains(l)), 'once it passed the tax test: its 4-pool loops appear (WETH -> PONS -> TAXY -> USDG -> WETH)');
  }

  // ---- (d) the lender is never one of the loop's 4 pools -----------------------------------
  {
    const v3 = (addr: string, a: string, b: string, feeBps: number) => ({ chain: 'robinhood', dex: 'uniswap-v3', poolType: 'v3', poolAddress: addr, tokenA: a, tokenB: b, feeBps, liquidity: 10n ** 20n }) as unknown as PoolState;
    // WETH start: the cheapest WETH lender is the loop's 4th pool (USDG/WETH).
    const fourth = v3(pUW.k, USDG, WETH, 1);
    const first = v3(pWP.k, WETH, PONS, 1);
    const other = v3(LENDER, WETH, A(0x77), 5);
    const loopPools = [pWP.k, pPD.k, pDU.k, pUW.k];
    // shadowMain passes the first two pools + "every pool after the first two".
    const exclude = [loopPools[0], loopPools[1], ...loopPools.slice(2)];
    assert(pickV3Lender([fourth, first, other], WETH, exclude)?.poolAddress === LENDER, 'cheapest lenders are the loop\'s 1st and 4th pools: the next one outside the loop is used');
    assert(pickV3Lender([fourth, first], WETH, exclude) === null, 'no lender outside the loop: none');
  }

  // ---- (e) gas: 4 hops costs more than 3 ---------------------------------------------------
  {
    assert(loopGasUnits(4) > loopGasUnits(3) && loopGasUnits(4) >= 600_000 && loopGasUnits(4) <= 700_000, `4-hop gas ${loopGasUnits(4)} units > 3-hop ${loopGasUnits(3)} (measured 4-hop own money ~646k)`);
    assert(loopGasUsd(0.05, 4) > loopGasUsd(0.05, 3), '4-pool gas in $ higher than 3-pool');
    const d = build(UNI, rulesOf(), on4());
    const l4 = d.byPool.get(pPD.k)!.find((l) => l.id === RIVAL_IDS[0])!;
    const { s, gasAsks } = senderOf();
    assert(s.gate(pickOf(loop4Cand(l4, null))) === null && gasAsks.includes(4), 'the loss-cap check asks for the gas of a 4-pool loop (not 3)');
    // Loss cap with $1.92 already lost: a 3-pool loop ($0.07) still fits under $2, a 4-pool one (~$0.088) does not.
    const { s: s2 } = senderOf({ otherLossTodayUsd: () => 1.92 });
    assert(/loop loss cap/.test(s2.gate(pickOf(loop4Cand(l4, null))) ?? ''), 'loss cap counts the higher 4-pool gas (stops a send a 3-pool loop would still fit)');
  }

  // ---- (f) per-pool caps, index cap, per-coin cap; 3-pool loops never pushed out ------------
  {
    // Extra: DJT/WETH (gives 3-pool loops WETH -> PONS -> DJT -> WETH through PONS/DJT)
    // and 20 coins Z with DJT/Z and Z/WETH pools (20+ more 4-pool loops through PONS/DJT).
    const pDW: P = { k: A(0x30), a: DJT, b: WETH, dex: 'uni', depth: 5_000 }; // shallow: 3-pool loops would lose a depth contest
    const extra: P[] = [pDW];
    for (let i = 0; i < 20; i++) {
      const Z = '0x' + (0x5000 + i).toString(16).padStart(40, '0');
      extra.push({ k: '0x' + (0x6000 + i).toString(16).padStart(40, '0'), a: DJT, b: Z, dex: 'uni', depth: 20_000 + i * 1_000 });
      extra.push({ k: '0x' + (0x7000 + i).toString(16).padStart(40, '0'), a: Z, b: WETH, dex: 'uni', depth: 20_000 + i * 1_000 });
    }
    const pools = [...UNI, ...extra];
    const pm = new Map(pools.map((p) => [p.k, p]));
    const three = build(pools, rulesOf());
    const three3 = (three.byPool.get(pPD.k) ?? []).map((l) => l.id);
    const full = build(pools, rulesOf(), on4({ perPool4: 1_000 }));
    const all4 = (full.byPool.get(pPD.k) ?? []).filter((l) => l.keys.length === 4);
    const d = build(pools, rulesOf(), on4({ perPool4: 3 }));
    const lst = d.byPool.get(pPD.k) ?? [];
    const l3 = lst.filter((l) => l.keys.length === 3), l4 = lst.filter((l) => l.keys.length === 4);
    assert(three3.length >= 2 && l3.map((l) => l.id).join() === three3.join(), `3-pool loops kept in full (${l3.length}) even though their pool is shallower than the 4-pool ones`);
    assert(all4.length > 3 && l4.length === 3, `per-pool 4-pool share: ${l4.length} kept of ${all4.length} (TRIG_ENTRY_LOOPS4_PER_POOL=3)`);
    const best3 = all4.slice().sort((p, q) => q.prio - p.prio).slice(0, 3).map((l) => l.prio);
    assert(l4.map((l) => l.prio).join() === best3.join(), 'the deepest 4-pool loops are the ones kept');
    assert(lst.indexOf(l4[0]) > lst.indexOf(l3[l3.length - 1]), 'each pool lists its 3-pool loops first, then its 4-pool share');
    assert([...d.byPool.values()].every((x) => x.filter((l) => l.keys.length === 4).length <= 3 && x.filter((l) => l.keys.length === 3).length <= 24), 'no pool holds more than its 3-pool and 4-pool shares');
    assert([...d.byPool.values()].flat().filter((l) => l.keys.length === 4).every((l) => chains(l, pm)), 'all kept 4-pool loops chain correctly');
    // Whole-index cap: 3-pool loops count first; the 4-pool part fills only what is left.
    const capTo = three.loops + 5;
    const dc = build(pools, rulesOf(), on4({ maxLoops: capTo }));
    const uniq4 = new Set([...dc.byPool.values()].flat().filter((l) => l.keys.length === 4).map((l) => l.id));
    assert(dc.loops <= capTo && dc.loops4 === 5 && uniq4.size === 5 && dc.capped, `TRIG_ENTRY_LOOP_INDEX_MAX honoured: ${dc.loops} loops (${dc.loops4} 4-pool) <= ${capTo}, reported capped`);
    const dz = build(pools, rulesOf(), on4({ maxLoops: three.loops }));
    assert(!dz.loops4 && [...dz.byPool.values()].flat().every((l) => l.keys.length === 3) && dz.loops === three.loops, 'no room left under the index cap: no 4-pool loops, 3-pool loops untouched');
    // Per-coin cap and the work limit (bounded search).
    const dp = build(pools, rulesOf(), on4({ perCoin4: 1 }));
    assert((dp.loops4 ?? 0) > 0 && (dp.loops4 ?? 0) < (full.loops4 ?? 0), `per-coin cap (TRIG_ENTRY_LOOPS4_PER_COIN=1): fewer loops looked at (${dp.loops4} vs ${full.loops4})`);
    const ds = build(pools, rulesOf(), on4({ maxSteps4: 10 }));
    assert(ds.capped && (ds.loops4 ?? 0) < (full.loops4 ?? 0), 'work limit (TRIG_ENTRY_LOOPS4_MAX_STEPS) stops the search and is reported');
  }

  // ---- (g) the contract call: 4 hops, in order --------------------------------------------
  {
    const d = build(UNI, rulesOf(), on4());
    const l4 = d.byPool.get(pPD.k)!.find((l) => l.id === RIVAL_IDS[0])!;
    const { s, fired } = senderOf();
    const p = pickOf(loop4Cand(l4, null));
    const r = await s.send(p, { hash: '0x1', seenMs: 0 });
    assert(r.signedMs !== undefined && fired.length === 1, 'own money: the 4-pool loop is sent');
    const dec = decodeExecuteCall(fired[0]);
    const hops = dec[0].hops as any[];
    const want = [[pWP.k, WETH, PONS], [pPD.k, PONS, DJT], [pDU.k, DJT, USDG], [pUW.k, USDG, WETH]];
    assert(hops.length === 4 && hops.every((h, i) => h.pool.toLowerCase() === want[i][0] && h.tokenIn.toLowerCase() === want[i][1] && h.tokenOut.toLowerCase() === want[i][2]),
      'execute call: 4 hops WETH -> PONS -> DJT -> USDG -> WETH, in order, each pool with the right coins');
    assert(dec[0].token.toLowerCase() === WETH && dec[0].amountIn === p.amountIn && dec[0].minProfit === 1_500_000n && dec[0].maxBlock === 12_345n, 'start coin, checked size, profit floor and deadline carried');
    const { s: s2, fired: f2 } = senderOf();
    await s2.send(pickOf(loop4Cand(l4, LENDER)), { hash: '0x1', seenMs: 0 });
    const fdec = new Interface(EXECUTE_ABI).decodeFunctionData('executeWithV3Flash', f2[0]);
    const fh = fdec[0].hops as any[];
    assert(fh.length === 4 && fh.map((h) => h.pool.toLowerCase()).join() === want.map((w) => w[0]).join() && String(fdec[1]).toLowerCase() === LENDER, 'flash-loan call: the same 4 hops in order, with the lender the check used');
  }

  // ---- CPU (TEST NUMBERS ONLY): ~1,200 pools, 4-pool loops on -------------------------------
  {
    // Fake universe like the live one: 2 hub coins (USDG, WETH), ~400 small
    // coins, most paired with WETH, about half with USDG, plus ~720 pools
    // between small coins. Deterministic (no random numbers).
    const coins = Array.from({ length: 400 }, (_, i) => '0x' + (0x10000 + i).toString(16).padStart(40, '0'));
    const big: P[] = [pUW];
    let n = 0x100000;
    const key = () => '0x' + (n++).toString(16).padStart(40, '0');
    coins.forEach((c, i) => {
      if (i % 10 < 7) big.push({ k: key(), a: WETH, b: c, dex: 'uni', depth: 1e4 + (i * 37) % 9e4 });
      if (i % 2 === 0) big.push({ k: key(), a: c, b: USDG, dex: 'uni', depth: 1e4 + (i * 53) % 9e4 });
    });
    for (let i = 0; i < 720; i++) big.push({ k: key(), a: coins[i % 400], b: coins[(i * 7 + 13) % 400], dex: 'uni', depth: 5e3 + (i * 29) % 5e4 });
    const r: LoopRules<P> = { key: (p) => p.k, tokens: (p) => [p.a, p.b], poolOk: () => true, coinOk: () => true, depth: (p) => p.depth };
    const time = (o: Partial<LoopBuildOpts>) => {
      // Drive the steps by hand to find the longest stretch between two
      // breaks (what would block the bot in one bite, before the 2 ms check).
      const job = buildLoopIndexSteps(big, [USDG, WETH], r, { ...loopIndexSettings({}), ...o });
      let worst = 0, res: any;
      const t0 = performance.now();
      for (;;) { const s0 = performance.now(); const x = job.next(); worst = Math.max(worst, performance.now() - s0); if (x.done) { res = x.value; break; } }
      return { ms: performance.now() - t0, worst, d: res };
    };
    const a = time({});
    const b = time({ poolsMax: 4 });
    const keys = big.slice(0, 100).map((p) => p.k);
    const t1 = performance.now();
    let found = 0;
    for (const k of keys) found += pickLoops([k], (x) => b.d.byPool.get(x) ?? [], () => true, () => 1, 4, rankRoutes).found;
    const per = (performance.now() - t1) / keys.length;
    console.log(`[bench, test numbers only] ${big.length} pools: 3-pool index ${a.d.loops} loops in ${a.ms.toFixed(1)} ms; with 4-pool ${b.d.loops} loops (${b.d.loops4} 4-pool${b.d.capped ? ', capped' : ''}) in ${b.ms.toFixed(1)} ms; longest stretch between breaks ${b.worst.toFixed(2)} ms; per trigger lookup+rank ${per.toFixed(3)} ms (avg ${(found / keys.length).toFixed(1)} loops per pool)`);
    assert((b.d.loops4 ?? 0) > 100 && b.d.loops <= 20_000, 'big set: hundreds of 4-pool loops, whole index within TRIG_ENTRY_LOOP_INDEX_MAX');
    assert(b.worst < 50, `never one long freeze: the longest stretch between breaks is ${b.worst.toFixed(2)} ms (the bot runs in between)`);
    assert(per < 2, 'a trigger\'s lookup + rank stays well under 2 ms with 4-pool loops on');
  }
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
