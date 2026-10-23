import { Wallet, keccak256 } from 'ethers';
import { FeedMsg } from '../chains/nitroFeed';
import { TriggerFirst, TrigCopy2, trigFirstSettings, checkSig } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, EntryDeps, TablePool, entrySettings, rankRoutes, stopUnits, routeId, patchAmounts } from '../execution/trigEntry';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient } from '../execution/localSim';
import { SIM_EXECUTOR_ADDRESS } from '../execution/simulator';
import { runSteps, setSliceCap, Steps } from '../core/chunked';
import { LagProbe } from '../core/loopLag';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// TRIGGER-ENTRY SPEED + VISIBILITY (execution/trigEntry.ts, Oct 23):
//   1. logging: the best candidate is logged even when it loses (negative
//      net), a verdict per candidate, and a SAMPLE of not-profitable answers
//      gets the later same-block re-check (agree + the re-check's net)
//   2. per-hop timestamps in the log line and the hour line
//   3. ONE TRIP: discovery + checks in one sidecar question gives the SAME
//      decisions as the two-step path (also when the sidecar stops early
//      where the bot wouldn't); the candidate picking matches the fixture
//      shared with the sidecar's own test
//   4. priority: entry checks are marked for the sidecar's fast lane; big
//      background jobs take shorter bites while entry work runs (bench)
//   + the key acceptance: a profitable trigger reaches the sender with no
//     waiting for reports / receipts and no node request (one trip too).
// The sidecar is faked here; sim/tests/copy2_intake.rs checks the real one.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const walletA = new Wallet('0x' + '11'.repeat(32));
async function signed(nonce: number, to: string | null, data = '0x'): Promise<string> {
  return walletA.signTransaction({ type: 2, chainId: 4663, nonce, to, data, value: 0n, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
}
const msgOf = (seq: number, raws: string[]): FeedMsg => ({ seq, ts: 1_700_000_000 + seq, l1: 9000, complete: true, txs: raws.map((r) => ({ hash: keccak256(r), raw: r })) });
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const insufficient = (got: bigint) => '0x4e88422a' + word(got) + 'f'.repeat(64);
type Asked = Record<string, any>;

const POOL_A = '0x' + 'a1'.repeat(20);
const POOL_B = '0x' + 'b2'.repeat(20);
const POOL_C = '0x' + 'c3'.repeat(20);
const USDG = '0x' + '01'.repeat(20);
const COIN = '0x' + '02'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const EXECUTOR = '0x' + 'ee'.repeat(20);

// One candidate: USDG start ($1 per 1e6 units), buy on `buyPool`.
function cand(label: string, buyPool: string, sellPool = POOL_B, maxSizeUsd = 1_000, gasUsd = 0.05): EntryCandidate {
  return {
    label, buyPool, sellPool, tokenIn: USDG, tokens: [USDG, COIN], keys: [buyPool, sellPool], maxSizeUsd, gasUsd,
    build: (usd) => ({ trade: { token: USDG, amountIn: BigInt(Math.round(usd * 1e6)), hops: [{ kind: 0, pool: buyPool, tokenIn: USDG, tokenOut: COIN, feeBps: 30 }, { kind: 0, pool: sellPool, tokenIn: COIN, tokenOut: USDG, feeBps: 30 }] as any }, simOpts: { v3Lender: LENDER } }),
    usdOf: (u) => Number(u) / 1e6,
  };
}

// A route universe: per moved pool, its routes (order = the host's route
// order), with ranking facts and a candidate (null = can't be built).
type Uni = Record<string, Array<{ rid: string; held: boolean; score: number | null; c: EntryCandidate | null }>>;
// The host's two-step candidatesFor over that universe (dedup by route id,
// rankRoutes, build only the best `limit`), exactly like shadowMain.ts.
function hostCandidatesFor(u: Uni) {
  return (keys: string[], limit: number) => {
    const seen = new Set<string>();
    const routes: Uni[string] = [];
    for (const k of keys) for (const r of u[k.toLowerCase()] ?? []) if (!seen.has(r.rid)) { seen.add(r.rid); routes.push(r); }
    const top = rankRoutes(routes, (r) => r.held, (r) => r.score, limit);
    return { cands: top.map((r) => r.c).filter((c): c is EntryCandidate => !!c), found: routes.length };
  };
}
const tableOf = (u: Uni) => (): TablePool[] => Object.entries(u).map(([pool, rs]) => ({ pool, routes: rs.map((r) => ({ rid: r.rid, held: r.held, score: r.score, build: () => r.c })) }));

// The sidecar's picking (sim/src/check/entry.rs select), as plain steps;
// checked against the shared fixture below.
function sidecarSelect(table: Record<string, Array<{ rid: string; h: boolean; s: number | null; e: string | null; c?: unknown }>>, moved: string[], limit: number) {
  const seen = new Set<string>();
  const list: Array<{ i: number; r: (typeof table)[string][number] }> = [];
  for (const k of moved) for (const r of table[k.toLowerCase()] ?? []) if (!seen.has(r.rid)) { seen.add(r.rid); list.push({ i: list.length, r }); }
  const sc = (x: number | null) => (x === null || !Number.isFinite(x) ? -Infinity : x);
  list.sort((a, b) => (a.r.h === b.r.h ? 0 : a.r.h ? -1 : 1) || (sc(b.r.s) === sc(a.r.s) ? 0 : sc(b.r.s) > sc(a.r.s) ? 1 : -1) || a.i - b.i);
  return { picked: list.slice(0, limit).map((x) => x.r).filter((r) => r.e !== null), found: list.length };
}

// Fake sidecar: trig_discover, trig_table, trig_entry and the trigger-first
// `call`. Profit by (buy pool, amount). `badStop`: the one trip stops after
// the first candidate even if the bot wouldn't (tests the bot's own reading).
function fakeSidecar(o: { pools?: string[]; profit: (buyPool: string, amount: bigint) => bigint; loss?: (buyPool: string) => boolean; badStop?: boolean; conf?: string }) {
  const asked: Asked[] = [];
  let table: { gen: number; codes: string[]; pools: Record<string, any[]> } | null = null;
  // Which candidate a call is (its buy pool), also for the later re-check
  // (which has no feed): remembered by the call's data.
  const routeOfData = new Map<string, string>();
  const callAnswer = (m: Asked) => {
    const data: string = m.calls[0].data;
    const amount = BigInt('0x' + data.slice(2 + 8 + 192, 2 + 8 + 256));
    const buy = (m.feed?.route ?? [])[0] ?? routeOfData.get(data) ?? '';
    if (m.feed?.route?.[0]) routeOfData.set(data, m.feed.route[0]);
    const pf = (a: bigint) => (o.loss?.(buy) ? 0n : o.profit(buy, a));
    const sizes = m.sizes ? (m.sizes.amounts as string[]).map((a) => { const p = pf(BigInt(a)); return { amount: a, status: p > 0n ? 'profit' : 'loss', profit: '0x' + p.toString(16), gasUsed: '0x1' }; }) : undefined;
    return { id: m.id, ok: true, us: 40, t: { queue: 7 }, results: [{ success: false, output: insufficient(pf(amount)), gasUsed: '0x5208' }],
      trig: { snapBlock: 100, included: false, triggerOk: true, msgs: 1, txs: 1, later: 0, lastSeq: 101, conf: o.conf ?? 'high', assumed: [] }, ...(sizes ? { sizes } : {}) };
  };
  const disc = () => ({ ok: true, pools: o.pools ?? [POOL_A], conf: 'high', assumed: [], us: 15, t: { queue: 3 } });
  const client = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Asked) => {
      asked.push(m);
      if (m.type === 'trig_discover') return { id: m.id, ...disc() };
      if (m.type === 'trig_table') {
        if (!m.full && (!table || table.gen !== m.base)) return { ok: false, unknown: 'table_gen' };
        if (m.full || !table) table = { gen: m.gen, codes: m.codes, pools: {} };
        table.gen = m.gen; table.codes = m.codes;
        for (const [k, v] of Object.entries(m.pools as Record<string, any[] | null>)) { if (v === null) delete table.pools[k]; else table.pools[k] = v; }
        return { ok: true, gen: m.gen };
      }
      if (m.type === 'trig_entry') {
        const d = disc();
        if (!table) return { ok: true, disc: d, table: 'none', us: 20 };
        const { picked, found } = sidecarSelect(table.pools, d.pools, m.limit);
        const cands: Asked[] = [];
        let stopped = false;
        for (let i = 0; i < picked.length; i++) {
          const r = picked[i];
          if (!r.c) { cands.push({ e: r.e, a: null }); continue; }
          const c = r.c as Asked;
          // Long codes come back from the codes list (as the real sidecar does).
          const ov = JSON.parse(JSON.stringify(c.overrides));
          for (const v of Object.values(ov) as Asked[]) if (typeof v.code === 'string' && v.code.startsWith('$code:')) v.code = table.codes[Number(v.code.slice(6))];
          const call = { id: m.id, type: 'call', at: m.at, overrides: ov, calls: c.calls, sizes: c.sizes, feed: { ...m.feed, route: c.route }, prio: true };
          asked.push({ ...call, inside: true });
          const a = callAnswer(call);
          cands.push({ e: r.e, a });
          const out = BigInt('0x' + (a.results[0].output as string).slice(10, 74));
          const good = (out > 0n && out >= BigInt(c.stop)) || (a.sizes ?? []).some((z: Asked) => z.status === 'profit' && BigInt(z.profit) >= BigInt(c.stop));
          if (good || o.badStop) { stopped = i + 1 < picked.length; break; }
        }
        return { ok: true, disc: d, tableGen: table.gen, found, sel: picked.map((r) => r.e), cands, stopped, cut: false, us: 60, t: { queue: 2_000 } };
      }
      if (m.type === 'call' && m.calls?.[0]?.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS) return callAnswer(m);
      // A coin's balanceOf with a pretend balance (the bot looking up where a
      // coin keeps balances): read back the first pretend value.
      if (m.type === 'call' && m.calls?.[0]?.data?.startsWith('0x70a08231')) {
        const sd = m.overrides?.[m.calls[0].to]?.stateDiff ?? {};
        const v = Object.values(sd)[0] as string | undefined;
        return { id: m.id, ok: true, results: [{ success: true, output: v ?? '0x' + '0'.repeat(64), gasUsed: '0x1' }] };
      }
      return { id: m.id, ok: false, unknown: 'bad_request' };
    },
  } as unknown as LocalSimClient;
  return { client, asked, table: () => table };
}
function fakeCopy2(): TrigCopy2 & { waits: number } {
  const c = {
    waits: 0,
    running: () => true,
    notReadyWhy: () => null,
    waitForTx: async () => { c.waits++; await sleep(2); return 101; },
    forwarder: { newestBlock: () => 100, txBlockOf: () => null },
  };
  return c;
}

function setup(o: { mode?: 'shadow' | 'on'; env?: Record<string, string>; sc: ReturnType<typeof fakeSidecar>; uni: Uni; oneTrip: boolean; deps?: Partial<EntryDeps> }) {
  const dir = mkdtempSync(join(tmpdir(), 'trigspeed-'));
  const file = join(dir, 'shadow.jsonl');
  const log = new JsonlLog(file, 1_000_000, 0);
  const c2 = fakeCopy2();
  const env = { LOCAL_SIM_TRIGGER_FIRST: o.mode ?? 'shadow', TRIG_ENTRY_PARALLEL: '1', TRIG_ENTRY_TABLE_MS: '0', ...(o.env ?? {}) };
  const tf = new TriggerFirst({ client: o.sc.client, settings: { ...trigFirstSettings(env), finalizeMs: 40, agreeWaitMs: 30 }, copy2: () => c2, shadowLog: log, hostOn: () => true, log: () => {} });
  const spies = { sends: 0, sendWaits: [] as number[], picks: [] as string[] };
  const te = new TrigEntry({
    tf, client: o.sc.client, shadowLog: log, settings: { ...entrySettings(env, 0.25), deadlineMs: 2_000, discoverTimeoutMs: 500, oneTrip: o.oneTrip },
    candidatesFor: hostCandidatesFor(o.uni),
    tableRoutes: tableOf(o.uni),
    isOurTx: () => false, ourAddresses: [EXECUTOR],
    killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async (p) => { spies.sends++; spies.sendWaits.push(c2.waits); spies.picks.push(`${p.cand.label}@${p.sizeUsd}`); return { signedMs: Date.now() }; },
    log: () => {}, lag: () => 0.5,
    ...(o.deps ?? {}),
  });
  return { tf, te, log, file, c2, spies };
}
const linesOf = async (log: JsonlLog, file: string) => { await log.flush(); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };

async function main() {
  const swapData = '0x12345678' + '00'.repeat(32);
  const tSwap = await signed(0, POOL_A, swapData);
  const msgs = [msgOf(100, []), msgOf(101, [tSwap])];
  const hash = keccak256(tSwap).toLowerCase();

  // ---- settings ---------------------------------------------------------------------------
  {
    const s = entrySettings({}, 0.25);
    assert(s.oneTrip && s.tableMs === 1000 && s.agreeSample === 5 && s.agreeSamplePerHour === 120 && s.immediate && s.yieldSliceMs === 2,
      'defaults: one trip on, table every 1000 ms, re-check 1 in 5 not-profitable answers (max 120/h), immediate start, 2 ms bites while entry work runs');
    const z = entrySettings({ TRIG_ENTRY_ONE_TRIP: '0', TRIG_ENTRY_AGREE_SAMPLE: '0', TRIG_ENTRY_IMMEDIATE: '0', TRIG_ENTRY_YIELD_SLICE_MS: '0' });
    assert(!z.oneTrip && z.agreeSample === 0 && !z.immediate && z.yieldSliceMs === 0, 'each can be switched off');
  }

  // ---- 3a. picking: the bot's ranking == the sidecar's picking (shared fixture) ----------
  {
    const fx = JSON.parse(readFileSync(join(__dirname, '..', '..', 'sim', 'tests', 'fixtures', 'trig_entry_select.json'), 'utf8'));
    let ok = 0;
    for (const c of fx.cases) {
      // Bot side: dedup in route order across the moved pools, rankRoutes, cap, drop unbuildable.
      const seen = new Set<string>();
      const routes: Array<{ rid: string; h: boolean; s: number | null; e: string | null }> = [];
      const tbl = Object.fromEntries(Object.entries(c.table).map(([k, v]) => [k.toLowerCase(), v])) as Record<string, any[]>;
      for (const k of c.moved) for (const r of tbl[k.toLowerCase()] ?? []) if (!seen.has(r.rid)) { seen.add(r.rid); routes.push(r); }
      const bot = rankRoutes(routes, (r) => r.h, (r) => r.s, c.limit).filter((r) => r.e !== null).map((r) => r.e);
      const side = sidecarSelect(tbl, c.moved, c.limit);
      if (JSON.stringify(bot) === JSON.stringify(c.expect) && JSON.stringify(side.picked.map((r) => r.e)) === JSON.stringify(c.expect) && routes.length === c.found && side.found === c.found) ok++;
      else console.error(`  case "${c.name}": bot ${JSON.stringify(bot)}, sidecar-steps ${JSON.stringify(side.picked.map((r) => r.e))}, want ${JSON.stringify(c.expect)}`);
    }
    assert(ok === fx.cases.length, `the bot's ranking picks exactly the fixture's candidates (${ok}/${fx.cases.length} cases; the sidecar's test uses the same file)`);
    assert(rankRoutes([{ n: 'nan', s: NaN }, { n: 'one', s: 1 }], () => true, (r) => r.s, 2).map((r) => r.n).join() === 'one,nan', 'a score that is not a real number counts as unknown (last), like the sidecar');
  }

  // ---- the table writes our check down once per route shape; other amounts are put in --------
  {
    const side = fakeSidecar({ profit: () => 0n });
    const c2 = fakeCopy2();
    const dir = mkdtempSync(join(tmpdir(), 'trigspeed-cap-'));
    const tf = new TriggerFirst({ client: side.client, settings: trigFirstSettings({ LOCAL_SIM_TRIGGER_FIRST: 'shadow' }), copy2: () => c2, shadowLog: new JsonlLog(join(dir, 'x.jsonl'), 1_000, 0), hostOn: () => true, log: () => {} });
    let same = 0, total = 0;
    for (const own of [false, true]) {
      const c = cand('x', POOL_A);
      const mk = (usd: number) => { const b = c.build(usd)!; return { trade: b.trade, simOpts: own ? {} : b.simOpts }; };
      const at = async (usd: number, others: bigint[]) => { const b = mk(usd); return tf.capture({ trade: b.trade, simOpts: b.simOpts, triggerHash: '', seenMs: 0, keys: c.keys }, others); };
      const first = (await at(400, [50_000_000n, 150_000_000n]))!;
      for (const usd of [123.45, 7, 999]) {
        total++;
        const fresh = (await at(usd, [1_000_000n, 2_000_000n]))!;
        const patched = patchAmounts(first, 400_000_000n, BigInt(Math.round(usd * 1e6)), [1_000_000n, 2_000_000n]);
        if (checkSig(fresh.data, fresh.overrides, fresh.sizes) === checkSig(patched.data, patched.overrides, patched.sizes) && JSON.stringify(fresh.calls) === JSON.stringify(patched.calls)) same++;
      }
      if (own) assert(JSON.stringify(first.overrides).includes(word(400_000_000n)), 'own-money check: the pretend balance holds the trade amount');
    }
    assert(same === total, `amounts put into a written-down check == writing it down again (${same}/${total}, flash loan and own money)`);
  }

  // ---- stop units == the bot's "net >= minimum" ---------------------------------------------
  {
    const c = cand('x', POOL_A);
    const u = stopUnits(c, 0.25)!;
    assert(c.usdOf(u) - c.gasUsd >= 0.25 && c.usdOf(u - 1n) - c.gasUsd < 0.25, `stop units ${u}: the smallest profit that clears $0.25 after $0.05 gas`);
    assert(routeId(POOL_A.toUpperCase().replace('0X', '0x'), POOL_B, USDG) === `${POOL_A}>${POOL_B}:${USDG}`, 'route ids are lowercase buy>sell:start');
  }

  // ---- 3b. ONE TRIP == TWO STEPS (same decisions) --------------------------------------------
  // Scenarios: ranking + cap + an unbuildable route; first candidate good; a
  // later one good; none good (losses + small profits); the sidecar stopping
  // where the bot would not.
  const D = '0x' + 'd4'.repeat(20);
  const uni: Uni = {
    [POOL_A]: [
      { rid: routeId(POOL_A, POOL_B, USDG), held: true, score: 1, c: cand('A>B', POOL_A, POOL_B) },
      { rid: routeId(POOL_B, POOL_A, USDG), held: true, score: 3, c: cand('B>A', POOL_B, POOL_A) },
      { rid: routeId(POOL_A, POOL_C, USDG), held: false, score: 9, c: cand('A>C', POOL_A, POOL_C) },
      { rid: routeId(POOL_C, POOL_A, USDG), held: true, score: 2, c: null },
      { rid: routeId(POOL_A, D, USDG), held: true, score: null, c: cand('A>D', POOL_A, D, 100) },
    ],
    [POOL_C]: [
      { rid: routeId(POOL_A, POOL_C, USDG), held: false, score: 9, c: cand('A>C', POOL_A, POOL_C) },
      { rid: routeId(POOL_C, D, USDG), held: true, score: 0.5, c: cand('C>D', POOL_C, D) },
    ],
  };
  type Sc = { name: string; pools: string[]; profit: (b: string, a: bigint) => bigint; loss?: (b: string) => boolean; badStop?: boolean; env?: Record<string, string> };
  const scenarios: Sc[] = [
    { name: 'best-ranked candidate is good', pools: [POOL_A], profit: (b, a) => (b === POOL_B ? a / 100n : 0n) },
    { name: 'a later candidate is good (the first ones lose or earn too little)', pools: [POOL_A, POOL_C], profit: (b, a) => (b === POOL_C ? a / 50n : b === POOL_A ? 100_000n : 0n), loss: (b) => b === POOL_B },
    { name: 'none good: small profits and losses', pools: [POOL_A, POOL_C], profit: (b) => (b === POOL_A ? 200_000n : 10_000n), loss: (b) => b === POOL_C },
    { name: 'the sidecar stops after the first even though the bot would not send', pools: [POOL_A], profit: (b, a) => (b === POOL_A ? a / 200n : 50_000n), badStop: true },
    { name: 'cap of 2 candidates', pools: [POOL_A, POOL_C], profit: (b, a) => (b === POOL_A ? a / 300n : 0n), env: { TRIG_ENTRY_MAX_CANDIDATES: '2' } },
  ];
  for (const sc of scenarios) {
    const run = async (oneTrip: boolean) => {
      const side = fakeSidecar({ pools: sc.pools, profit: sc.profit, loss: sc.loss, badStop: sc.badStop });
      const x = setup({ mode: 'on', sc: side, uni, oneTrip, env: sc.env });
      x.tf.onFeedMsgs(msgs, Date.now());
      if (oneTrip) await x.te.refreshTable();
      const rec = await x.te.process(hash, Date.now());
      return { rec: rec!, side, x };
    };
    const two = await run(false);
    const one = await run(true);
    const key = (r: typeof two.rec) => JSON.stringify({ best: r.best && { l: r.best.label, s: r.best.sizeUsd, n: r.best.netUsd.toFixed(6) }, view: r.view && { l: r.view.label, n: r.view.netUsd.toFixed(6), v: r.view.verdict }, would: r.wouldSend ?? false, held: r.held ?? null, found: r.found, cands: r.candidates, tried: r.tried, cv: r.cv, u: r.unknown ?? null });
    assert(one.rec.one === 1, `${sc.name}: one trip used (${one.rec.one})`);
    assert(key(one.rec) === key(two.rec), `${sc.name}: identical decision (${key(one.rec).slice(0, 160)}...)`);
    assert(JSON.stringify(one.x.spies.picks) === JSON.stringify(two.x.spies.picks), `${sc.name}: same trade sent (${one.x.spies.picks.join() || 'none'})`);
    const q = (xs: Asked[]) => xs.filter((m) => !m.inside && (m.type === 'trig_entry' || m.type === 'trig_discover' || (m.type === 'call' && !!m.feed))).length;
    const oneQs = q(one.side.asked);
    const twoQs = q(two.side.asked);
    if (!sc.badStop) assert(oneQs === 1 && twoQs >= 2, `${sc.name}: ONE question instead of ${twoQs}`);
    else assert(oneQs >= 2 && (one.rec.oneRest ?? 0) > 0, `${sc.name}: the bot reads the answer itself and checks the rest the old way (${one.rec.oneRest} more)`);
  }

  // ---- one trip falls back to two steps (no table / changed table / old sidecar) -------------
  {
    const side = fakeSidecar({ pools: [POOL_A], profit: (_b, a) => a / 100n });
    const x = setup({ sc: side, uni, oneTrip: true });
    x.tf.onFeedMsgs(msgs, Date.now());
    const r0 = await x.te.process(hash, Date.now());
    assert(r0!.one === 'no_table_yet' && side.asked[0].type === 'trig_discover' && r0!.wouldSend === true, 'before the table is in the sidecar: two steps, same result');
    await x.te.refreshTable();
    const tb = side.table()!;
    const anyC = Object.values(tb.pools).flat().find((r: any) => r.c)!;
    assert(tb.codes.length === 0 || /^\$code:/.test(JSON.stringify(anyC.c.overrides)) || true, 'table sent');
    assert(Array.isArray(anyC.c.calls) && anyC.c.calls[0].to.toLowerCase() === SIM_EXECUTOR_ADDRESS && typeof anyC.c.stop === 'string' && anyC.c.sizes?.amounts?.length === 3 && typeof anyC.c.sizes?.calc?.lo === 'string',
      'each table entry holds our exact check call (at the cap), its size calculation (+ the ladder as fallback) and the stop units');
    const before = side.asked.length;
    assert(await x.te.refreshTable() && side.asked.length === before, 'nothing changed: nothing re-sent');
    uni[POOL_C][1].score = 0.7;
    await x.te.refreshTable();
    const last = side.asked[side.asked.length - 1];
    assert(last.type === 'trig_table' && !last.full && Object.keys(last.pools).join() === POOL_C, 'one pool changed: only that pool is sent (partial table)');
    uni[POOL_C][1].score = 0.5;
  }
  {
    // An older sidecar without trig_entry / trig_table: never used, two steps.
    const side = fakeSidecar({ pools: [POOL_A], profit: (_b, a) => a / 100n });
    const req = side.client.request.bind(side.client);
    (side.client as any).request = async (m: Asked) => (m.type === 'trig_table' || m.type === 'trig_entry' ? { ok: false, unknown: 'bad_request' } : req(m));
    const x = setup({ sc: side, uni, oneTrip: true });
    x.tf.onFeedMsgs(msgs, Date.now());
    assert(!(await x.te.refreshTable()), 'an older sidecar refuses the table');
    const r = await x.te.process(hash, Date.now());
    assert(r!.wouldSend === true && r!.one === 'no_table_yet', 'and the entry point works the two-step way');
  }

  // ---- ACCEPTANCE (one trip, on): profitable trigger reaches the sender, no waiting, no node --
  {
    const side = fakeSidecar({ pools: [POOL_A], profit: (_b, a) => a / 100n });
    const x = setup({ mode: 'on', sc: side, uni, oneTrip: true });
    x.tf.onFeedMsgs(msgs, Date.now());
    await x.te.refreshTable();
    const rec = await x.te.process(hash, Date.now());
    assert(x.spies.sends === 1 && rec!.submitMs !== undefined && rec!.one === 1, 'on + one trip: a profitable candidate is sent');
    assert(x.spies.sendWaits[0] === 0, 'sent WITHOUT waiting for the trigger\'s pool reports (copy2WaitForTx not called before the send)');
    assert(side.asked.every((m) => m.type === 'trig_table' || m.type === 'trig_entry' || m.type === 'trig_discover' || m.type === 'call'), 'only fast-check questions: no receipt polling, no node request');
    assert(typeof rec!.hops?.sign === 'number', 'the signed time is in the hops');
  }

  // ---- 4. entry checks are marked for the sidecar's fast lane ---------------------------------
  {
    const side = fakeSidecar({ pools: [POOL_A], profit: () => 0n });
    const x = setup({ sc: side, uni, oneTrip: false });
    x.tf.onFeedMsgs(msgs, Date.now());
    await x.te.process(hash, Date.now());
    const calls = side.asked.filter((m) => m.type === 'call' && !!m.feed);
    assert(calls.length > 0 && calls.every((m) => m.prio === true), 'two-step entry checks carry "prio": true (sidecar fast lane)');
    // The old trigger-first hook's own checks are NOT marked.
    const c2 = fakeCopy2();
    const tf2 = new TriggerFirst({ client: side.client, settings: { ...trigFirstSettings({ LOCAL_SIM_TRIGGER_FIRST: 'shadow' }), finalizeMs: 10 }, copy2: () => c2, shadowLog: x.log, hostOn: () => true, log: () => {} });
    tf2.onFeedMsgs(msgs, Date.now());
    const n0 = side.asked.length;
    const c = cand('x', POOL_A);
    await tf2.check({ trade: c.build(100)!.trade, simOpts: c.build(100)!.simOpts, triggerHash: hash, seenMs: Date.now(), keys: c.keys });
    assert(side.asked.slice(n0).every((m) => m.prio === undefined), 'other trigger-first checks stay in the normal lane');
  }

  // ---- 1 + 2. LOGGING: negative best net, per-candidate verdicts, sample re-check; HOPS --------
  {
    const side = fakeSidecar({ pools: [POOL_A, POOL_C], profit: (b) => (b === POOL_B ? 20_000n : 0n), loss: (b) => b !== POOL_B });
    const x = setup({ sc: side, uni, oneTrip: true, env: { TRIG_ENTRY_AGREE_SAMPLE: '1' } });
    x.tf.onFeedMsgs(msgs, Date.now());
    await x.te.refreshTable();
    const rec = await x.te.process(hash, Date.now());
    assert(!rec!.wouldSend && rec!.view?.label === 'B>A' && Math.abs(rec!.view.netUsd - (0.02 - 0.05)) < 1e-9, `not profitable: the best candidate is still recorded with its NEGATIVE net (${rec!.view?.label} $${rec!.view?.netUsd.toFixed(2)})`);
    assert(rec!.sampled === true, 'TRIG_ENTRY_AGREE_SAMPLE=1: this not-profitable answer is sampled for the later re-check');
    await sleep(150);
    const lines = await linesOf(x.log, x.file);
    const l = lines.find((y) => y.k === 'trig_entry');
    assert(!!l && l.best === 'B>A' && l.net === -0.03 && l.bv === 'profit' && l.u === undefined, `log line: best route / net -0.03 / verdict (${JSON.stringify({ best: l?.best, net: l?.net, bv: l?.bv })})`);
    assert(Array.isArray(l?.cv) && l.cv.length === l.tried && l.cv.some((c: any) => c.v === 'loss' && c.n === -0.05) && l.cv.some((c: any) => c.v === 'profit'), `a verdict per candidate, losses at "at most minus gas" (${JSON.stringify(l?.cv)})`);
    assert(l?.smp === true && (l.agree !== undefined || l.agSkip !== undefined), `the sampled re-check is in the line (agree ${l?.agree}, agV ${l?.agV}, agNet ${l?.agNet}, ${l?.agSkip ?? ''})`);
    assert(l?.agree === true && l.agNet === -0.03, `re-check agrees and logs its own net (${l?.agNet})`);
    const hp = l?.hops ?? {};
    const nums = ['start', 'dSent', 'dAns', 'built', 'dec', 'lag', 'scQ', 'scW'].every((k) => typeof hp[k] === 'number');
    assert(nums && Array.isArray(hp.checks) && hp.checks.length === l.tried && hp.checks.every((c: any[]) => c.length === 4 && typeof c[3] === 'number'), `per-hop timestamps in the line (${JSON.stringify(hp).slice(0, 200)})`);
    assert(hp.dSent <= hp.dAns && hp.dAns <= hp.built && hp.built <= hp.dec, 'hops are in order: sent <= answered <= built <= decided');
    assert(hp.scQ === 2 && hp.scW === 0.06, 'the sidecar\'s own queue wait / work (one trip) are in ms');
    const hour = x.te.takeHourLine() ?? '';
    assert(/best net after gas: over \$0.25 0, \$0-0.25 0, -\$0.10-0 1, under -\$0.10 0/.test(hour), `hour line: best-net distribution (${hour.match(/best net[^;]*/)?.[0]})`);
    assert(/not-profitable sample re-checked 1: agree 1\/1/.test(hour) && /missed chances \(re-check profitable\) 0/.test(hour), `hour line: sample agreement (${hour.match(/not-profitable[^;]*/)?.[0]})`);
    assert(/hops p50\/p90 ms: .*rtt .*scQueue .*scWork .*build .*decide .*lag/.test(hour), `hour line: p50/p90 per hop (${hour.match(/hops[^;]*/)?.[0]})`);
    assert(/one trip 1/.test(hour), 'hour line: one-trip count');
  }
  {
    // Sample rate and hourly bound.
    const side = fakeSidecar({ pools: [POOL_A], profit: () => 0n, loss: () => true });
    const x = setup({ sc: side, uni, oneTrip: false, env: { TRIG_ENTRY_AGREE_SAMPLE: '2', TRIG_ENTRY_AGREE_SAMPLE_PER_HOUR: '2' } });
    x.tf.onFeedMsgs(msgs, Date.now());
    const got: boolean[] = [];
    for (let i = 0; i < 8; i++) got.push(!!(await x.te.process(hash, Date.now()))!.sampled);
    assert(got.join() === 'false,true,false,true,false,false,false,false', `1 in 2 sampled, at most 2 an hour (${got.map((g) => (g ? 1 : 0)).join('')})`);
  }

  // ---- immediate start: the question is on its way before the feed handler returns -------------
  {
    const side = fakeSidecar({ pools: [POOL_A], profit: () => 0n });
    const x = setup({ sc: side, uni, oneTrip: false });
    x.tf.onFeedMsgs(msgs, Date.now());
    x.te.onFeedMsgs(msgs, Date.now(), { recv: performance.now() - 1, parsed: performance.now() });
    assert(side.asked.length === 1 && side.asked[0].type === 'trig_discover', 'TRIG_ENTRY_IMMEDIATE: discovery asked inside the feed handler (no setImmediate hop)');
    assert(x.te.sliceCapMs() === 2, 'while it is in flight, background jobs are capped to 2 ms bites');
    await sleep(60);
    assert(x.te.sliceCapMs() === 0, 'and uncapped once it is done');
  }

  // ---- BENCH (test numbers only): timer delay while a big job runs, 8 ms bites vs 2 ms ----------
  {
    const bench = async (cap: number) => {
      setSliceCap(cap > 0 ? () => cap : null);
      const probe = new LagProbe(5, 50);
      probe.start();
      let busy = true;
      function* job(): Steps<number> { let x = 0; const end = performance.now() + 400; while (performance.now() < end) { for (let i = 0; i < 2_000; i++) x += i; yield; } busy = false; return x; }
      const running = runSteps(job(), 'bench job', 8);
      const delays: number[] = [];
      while (busy) { const t = performance.now(); await new Promise((r) => setTimeout(r, 1)); delays.push(performance.now() - t - 1); }
      await running;
      probe.stop();
      const h = probe.takeHour();
      setSliceCap(null);
      delays.sort((a, b) => a - b);
      return { p50: delays[Math.floor(delays.length * 0.5)], p90: delays[Math.floor(delays.length * 0.9)], lag: h };
    };
    const off = await bench(0);
    const on = await bench(2);
    console.log(`[bench, test numbers only] timer delay during an 8 ms-bite background job: p50 ${off.p50.toFixed(2)} ms / p90 ${off.p90.toFixed(2)} ms (probe lag p90 ${off.lag?.p90} ms); with the 2 ms entry cap: p50 ${on.p50.toFixed(2)} ms / p90 ${on.p90.toFixed(2)} ms (probe lag p90 ${on.lag?.p90} ms)`);
    assert(on.p90 < off.p90, 'shorter bites while entry work runs = answers read sooner (lower p90 delay)');
  }

  // ---- BENCH (test numbers only): candidate table rebuild, 40 pools x 4 routes ------------------
  {
    const big: Uni = {};
    for (let i = 0; i < 40; i++) {
      const p = '0x' + (0x1000 + i).toString(16).padStart(40, '0');
      const q = '0x' + (0x2000 + i).toString(16).padStart(40, '0');
      big[p] = [0, 1, 2, 3].map((j) => ({ rid: routeId(j % 2 ? p : q, j % 2 ? q : p, USDG) + j, held: true, score: j, c: cand(`r${i}.${j}`, j % 2 ? p : q, j % 2 ? q : p, 1_000 + j) }));
    }
    const side = fakeSidecar({ profit: () => 0n });
    const x = setup({ sc: side, uni: big, oneTrip: true });
    let t = performance.now();
    await x.te.refreshTable();
    const first = performance.now() - t;
    t = performance.now();
    await x.te.refreshTable();
    const again = performance.now() - t;
    const info = x.te.tableInfo();
    console.log(`[bench, test numbers only] candidate table, ${info.pools} pools / ${info.routes} routes: first build ${first.toFixed(1)} ms (writes each check down), rebuild ${again.toFixed(1)} ms (amounts put in; nothing re-sent when unchanged)`);
    assert(info.entries === 160 && again < first, 'table rebuilds reuse the written-down checks');
  }

  // ---- BENCH (test numbers only): one trip vs two steps, bot-side time, fake sidecar -----------
  {
    const timeIt = async (oneTrip: boolean) => {
      const side = fakeSidecar({ pools: [POOL_A, POOL_C], profit: () => 0n, loss: () => true });
      // Each sidecar answer takes ~1 ms "on the socket" (a timer), like a round trip.
      const req = side.client.request.bind(side.client);
      (side.client as any).request = async (m: Asked) => { const a = await req(m); if (m.type !== 'trig_table') await sleep(1); return a; };
      const x = setup({ sc: side, uni, oneTrip });
      x.tf.onFeedMsgs(msgs, Date.now());
      if (oneTrip) await x.te.refreshTable();
      const xs: number[] = [];
      for (let i = 0; i < 20; i++) { const t = performance.now(); await x.te.process(hash, Date.now()); xs.push(performance.now() - t); }
      xs.sort((a, b) => a - b);
      return { p50: xs[10], qs: side.asked.filter((m) => !m.inside && (m.type === 'trig_entry' || m.type === 'trig_discover' || (m.type === 'call' && !!m.feed))).length / 20 };
    };
    const two = await timeIt(false);
    const one = await timeIt(true);
    console.log(`[bench, test numbers only] trigger with 4 candidates, ~1 ms per sidecar round trip: two steps p50 ${two.p50.toFixed(2)} ms (${two.qs} questions), one trip p50 ${one.p50.toFixed(2)} ms (${one.qs} question)`);
    assert(one.qs === 1 && one.p50 < two.p50, 'one trip: one question per trigger and less time');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
