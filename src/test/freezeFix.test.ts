import { Wallet, ethers, keccak256, Transaction } from 'ethers';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseFeedFrame, parseFeedMessages, decodeFeedTx, feedTxHash, clearFeedTxMemo } from '../chains/nitroFeed';
import { StallFinder } from '../core/stallFinder';
import { FreezeProfiler, freezeProfileSettings, topSelfTime, recordCpuProfile, CpuProfile } from '../core/freezeProfile';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings, quickSkip } from '../execution/trigEntry';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient } from '../execution/localSim';

// ============================================================================
// FREEZE FIX (Oct 23): the bot's thread was freezing 200+ times per 5 min.
// This file proves the fixes keep every RESULT the same, and measures the
// speed-ups on this test machine (numbers labelled "TEST numbers": the
// server is a different machine with real traffic).
//   1. feed transactions are unpacked / hashed once, not three times
//   2. a reconnect's backlog replay is not unpacked again
//   3. the stall finder no longer counts the same work several times
//   4. the one-trip candidate table reuses unchanged routes, same table
//   5. the freeze profiler (CPU profile after repeated long freezes)
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const busy = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) { /* spin */ } };

// ---- a realistic feed message: N signed router swaps (~1 KB each) ----------------------
const ROUTER = '0x' + '12'.repeat(20);
const iface = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
function batchEntry(msg: Buffer): Buffer { const len = Buffer.alloc(8); len.writeBigUInt64BE(BigInt(msg.length)); return Buffer.concat([len, msg]); }
const signedTxMsg = (raw: string) => Buffer.concat([Buffer.from([4]), Buffer.from(raw.slice(2), 'hex')]);
async function swaps(n: number, seed = 1): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = new Wallet('0x' + (seed * 1000 + i + 1).toString(16).padStart(64, '0'));
    const data = iface.encodeFunctionData('execute', ['0x0b00', ['0x' + 'ab'.repeat(320), '0x' + 'cd'.repeat(256)], 9_999_999_999n]);
    out.push(await w.signTransaction({ type: 2, chainId: 4663, nonce: i, to: ROUTER, data, value: BigInt(i), gasLimit: 300_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n }));
  }
  return out;
}
const frameOf = (msgs: Array<{ seq: number; raws: Buffer[] }>) => ({
  version: 1,
  messages: msgs.map((m) => ({ sequenceNumber: m.seq, message: { message: { header: { kind: 3, timestamp: 1_700_000_000 + m.seq, blockNumber: 9000 }, l2Msg: Buffer.concat([Buffer.from([3]), ...m.raws.map(batchEntry)]).toString('base64') }, delayedMessagesRead: 1 } })),
});
// Comparable view of parsed transactions (lazy `from` read too).
const viewTxs = (txs: ReturnType<typeof parseFeedFrame>) => JSON.stringify(txs.map((t) => ({ ...t, from: t.from })));

async function feedTests() {
  const raws = await swaps(20);
  const plain = await new Wallet('0x' + '77'.repeat(32)).signTransaction({ type: 2, chainId: 4663, nonce: 0, to: ROUTER, data: '0x', value: 5n, gasLimit: 21_000, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
  const broken = Buffer.from([0x02, 0xc0, 0x01]); // a "signed transaction" ethers can't read
  const items = [...raws.map(signedTxMsg), signedTxMsg(plain), Buffer.concat([Buffer.from([4]), broken])];
  const frame = frameOf([{ seq: 500, raws: items.slice(0, 11) }, { seq: 501, raws: items.slice(11) }]);
  const ours = { isOurTx: () => false, addresses: new Set<string>() };

  // 1. Same results with and without the memory (memory off = the old code path).
  process.env.FEED_TX_MEMO = '0';
  const oldMsgs = JSON.stringify(parseFeedMessages(frame));
  const oldSkips = raws.concat([plain]).map((r) => quickSkip(r, keccak256(r), ours));
  const oldTxs = viewTxs(parseFeedFrame(frame));
  delete process.env.FEED_TX_MEMO;
  const newMsgs = JSON.stringify(parseFeedMessages(frame));
  const newSkips = raws.concat([plain]).map((r) => quickSkip(r, keccak256(r), ours));
  const newTxs = viewTxs(parseFeedFrame(frame));
  assert(oldMsgs === newMsgs, 'order buffer messages identical (hashes from the raw bytes = hashes of the text form)');
  assert(JSON.stringify(oldSkips) === JSON.stringify(newSkips) && newSkips[newSkips.length - 1] === 'plain_transfer', 'entry point skip answers identical');
  assert(oldTxs === newTxs && JSON.parse(newTxs).length === 20, 'trade decoder transactions identical (to, data, value, hash, raw, place, sender)');
  assert(JSON.parse(newMsgs)[1].txs.length === 11, 'a transaction ethers cannot read is still listed raw for the order buffer (as before)');
  const one = JSON.parse(newTxs)[3];
  assert(one.hash === Transaction.from(raws[3]).hash && one.from === Transaction.from(raws[3]).from, 'hash and sender match ethers exactly');
  assert(decodeFeedTx('0x02c001') === null && decodeFeedTx('0x02c001') === null, 'unreadable transaction: null (remembered), never throws');
  assert(feedTxHash(raws[0]) === keccak256(raws[0]) && feedTxHash(raws[1], Buffer.from(raws[1].slice(2), 'hex')) === keccak256(raws[1]), 'hash helper = keccak256');

  // 2. Backlog replay: messages at or below the last sequence number are skipped.
  const all = parseFeedMessages(frame);
  const after = parseFeedMessages(frame, 500);
  assert(all.length === 2 && after.length === 1 && after[0].seq === 501 && JSON.stringify(after[0]) === JSON.stringify(all[1]), 'afterSeq: only newer messages are unpacked, unchanged');
  assert(parseFeedMessages(frame, 501).length === 0 && parseFeedMessages(frame, undefined).length === 2, 'afterSeq: all old = nothing; not given = everything (old behaviour)');

  // BENCH (TEST numbers): one feed message of 20 swaps through the three readers.
  const fresh = await swaps(20, 7);
  const benchFrame = (seq: number) => frameOf([{ seq, raws: fresh.map(signedTxMsg) }]);
  const pipeline = (seq: number) => {
    // Every transaction is new to the bot (as in real life): nothing remembered from the last round.
    clearFeedTxMemo();
    const f = benchFrame(seq);
    const msgs = parseFeedMessages(f);
    for (const m of msgs) for (const t of m.txs) quickSkip(t.raw, t.hash, ours);
    parseFeedFrame(f);
  };
  const run = (n: number) => { const t = performance.now(); for (let i = 0; i < n; i++) pipeline(1_000 + i); return (performance.now() - t) / n; };
  process.env.FEED_TX_MEMO = '0'; run(3); const before = run(15);
  delete process.env.FEED_TX_MEMO; run(3); const nowMs = run(15);
  console.log(`[bench, TEST numbers] feed message with 20 swaps (order buffer + entry skip test + trade decoder): before ${before.toFixed(1)} ms, now ${nowMs.toFixed(1)} ms (${(before / nowMs).toFixed(1)}x faster)`);
  assert(nowMs < before * 0.85, 'unpacking each transaction once is clearly faster');
  // Backlog bench: a reconnect replays 200 messages of 5 swaps we already had.
  const backlog = frameOf(Array.from({ length: 200 }, (_, i) => ({ seq: 2_000 + i, raws: fresh.slice(0, 5).map(signedTxMsg) })));
  // Old path: every message unpacked and every transaction through the entry point's skip test.
  const tap = (after?: number) => { for (const m of parseFeedMessages(backlog, after)) for (const x of m.txs) quickSkip(x.raw, x.hash, ours); };
  process.env.FEED_TX_MEMO = '0';
  let t = performance.now(); tap(); const replayOld = performance.now() - t;
  t = performance.now(); tap(2_199); const replayNew = performance.now() - t;
  delete process.env.FEED_TX_MEMO;
  console.log(`[bench, TEST numbers] reconnect backlog of 200 known messages (1,000 swaps) through the trigger-first tap: before ${replayOld.toFixed(0)} ms in one go, now ${replayNew.toFixed(1)} ms (skipped)`);
  assert(replayNew < replayOld / 10, 'a backlog of known messages costs (almost) nothing');
}

// ---- 3. stall finder: overlapping marks ----------------------------------------------------
async function stallTests() {
  // 5 feed trades resume in the same turn, each marks "feed trade" and works 8 ms.
  const sf = new StallFinder({ enabled: false });
  const t0 = performance.now();
  const job = async () => { await Promise.resolve(); sf.mark('feed trade'); busy(8); };
  await Promise.all([job(), job(), job(), job(), job()]);
  await new Promise((r) => setImmediate(r));
  const t1 = performance.now();
  sf.recordStall(t0, t1, t1 - t0);
  const s = sf.take('fiveMin');
  const ft = s.causes.find((c) => c.name === 'feed trade');
  console.log(`[stall finder] freeze ${(t1 - t0).toFixed(0)} ms, blamed on "feed trade": ${ft?.maxMs.toFixed(0)} ms (before the fix: about 3x the freeze)`);
  assert(!!ft && ft.maxMs <= (t1 - t0) + 0.5 && ft.maxMs >= 30, 'marks no longer overlap: a freeze is never blamed for more than its own length');
  const longest = s.longest.find((j) => j.name === 'feed trade');
  assert(!!longest && longest.maxMs < 15, `each marked stretch covers only its own trade (longest ${longest?.maxMs.toFixed(1)} ms, work 8 ms)`);
}

// ---- 4. one-trip table reuse --------------------------------------------------------------------
const USDG = '0x' + '01'.repeat(20);
const COIN = '0x' + '02'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
type Pool = { addr: string; ver: number };
function fakeClient() {
  const tables: Array<Record<string, any>> = [];
  const client = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Record<string, any>) => {
      if (m.type === 'trig_table') { tables.push(JSON.parse(JSON.stringify(m))); return { ok: true, gen: m.gen }; }
      // A coin's balanceOf with a pretend balance: read back the first pretend value.
      if (m.type === 'call' && m.calls?.[0]?.data?.startsWith('0x70a08231')) {
        const sd = m.overrides?.[m.calls[0].to]?.stateDiff ?? {};
        const v = Object.values(sd)[0] as string | undefined;
        return { id: m.id, ok: true, results: [{ success: true, output: v ?? '0x' + '0'.repeat(64), gasUsed: '0x1' }] };
      }
      return { id: m.id, ok: false, unknown: 'bad_request' };
    },
  } as unknown as LocalSimClient;
  return { client, tables };
}
const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 1, forwarder: { newestBlock: () => 1, txBlockOf: () => null } };
// `nPools` pools, 4 routes each; each build costs `buildMs` (like buildCheck).
function universe(nPools: number, buildMs: number) {
  const pools: Pool[] = Array.from({ length: nPools }, (_, i) => ({ addr: '0x' + (0xa000 + i).toString(16).padStart(40, '0'), ver: 0 }));
  const peer: Pool = { addr: '0x' + 'b2'.repeat(20), ver: 0 };
  let builds = 0;
  const candOf = (buy: Pool, sell: Pool, j: number): EntryCandidate => ({
    label: `R${j} ${buy.addr.slice(-4)}>${sell.addr.slice(-4)}`, buyPool: buy.addr, sellPool: sell.addr, tokenIn: USDG, tokens: [USDG, COIN], keys: [buy.addr, sell.addr], maxSizeUsd: 400, gasUsd: 0.05,
    build: (usd) => {
      builds++; busy(buildMs);
      // The trade depends on the pools' state (ver): a changed pool = a different trade.
      return { trade: { token: USDG, amountIn: BigInt(Math.round(usd * 1e6)) + BigInt(buy.ver + sell.ver), hops: [{ kind: 0, pool: buy.addr, tokenIn: USDG, tokenOut: COIN, feeBps: 30 }, { kind: 0, pool: sell.addr, tokenIn: COIN, tokenOut: USDG, feeBps: 30 + j }] as any }, simOpts: { v3Lender: LENDER } };
    },
    usdOf: (u) => Number(u) / 1e6,
  });
  // Pool states are replaced (never edited) when they change, like the price cache.
  const bump = (i: number) => { pools[i] = { ...pools[i], ver: pools[i].ver + 1 }; };
  const routesOf = (p: Pool): TableRoute[] => [0, 1, 2, 3].map((j) => {
    const [buy, sell] = j % 2 ? [peer, p] : [p, peer];
    return { rid: `${buy.addr}>${sell.addr}:${USDG}:${j}`, held: true, score: j, build: () => candOf(buy, sell, j), inputs: [buy, sell, 1, 6] };
  });
  return {
    tableLazy: (): TablePool[] => pools.map((p) => ({ pool: p.addr, routes: () => routesOf(p) })),
    tableArray: (): TablePool[] => pools.map((p) => ({ pool: p.addr, routes: routesOf(p).map(({ inputs: _i, ...r }) => r) })),
    bump, builds: () => builds,
  };
}
function entryWith(u: ReturnType<typeof universe>, lazy: boolean, reuseMs: number) {
  const { client, tables } = fakeClient();
  const env = { LOCAL_SIM_TRIGGER_FIRST: 'shadow', TRIG_ENTRY_TABLE_MS: '0' };
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'freezefix-')), 'x.jsonl'), 1_000_000, 0);
  const tf = new TriggerFirst({ client, settings: trigFirstSettings(env), copy2: () => copy2, shadowLog: log, hostOn: () => true, log: () => {} });
  const te = new TrigEntry({
    tf, client, shadowLog: log, settings: { ...entrySettings(env, 0.25), tableReuseMs: reuseMs },
    candidatesFor: () => ({ cands: [], found: 0 }), tableRoutes: lazy ? u.tableLazy : u.tableArray,
    isOurTx: () => false, ourAddresses: [], killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => ({}), log: () => {}, lag: () => 0,
  });
  return { te, tables, tf };
}
// The table as the sidecar holds it (ids left out: they are just labels).
function heldTable(tables: Array<Record<string, any>>): string {
  const pools: Record<string, any> = {};
  let codes: string[] = [];
  for (const t of tables) {
    if (t.full) for (const k of Object.keys(pools)) delete pools[k];
    codes = t.codes;
    for (const [k, v] of Object.entries(t.pools as Record<string, any>)) { if (v === null) delete pools[k]; else pools[k] = v; }
  }
  const norm = Object.keys(pools).sort().map((k) => [k, pools[k].map((r: any) => ({ ...r, e: r.e === null ? null : 'id', c: r.c ? JSON.parse(JSON.stringify(r.c).replace(/"\$code:(\d+)"/g, (_m, i) => JSON.stringify(codes[Number(i)]))) : r.c }))]);
  return JSON.stringify(norm);
}

async function tableTests() {
  // Same table: reuse on (lazy routes) vs off (routes as a list, the old way).
  const uA = universe(12, 0), uB = universe(12, 0);
  const A = entryWith(uA, true, 5_000), B = entryWith(uB, false, 0);
  await A.te.refreshTable(); await B.te.refreshTable();
  assert(heldTable(A.tables) === heldTable(B.tables) && A.tables.length === 1, 'first build: the same table as the old builder');
  const b0 = uA.builds();
  await A.te.refreshTable(); await B.te.refreshTable();
  assert(uA.builds() === b0 && A.te.tableInfo().reused === 48, 'nothing changed: no route is built again (48 reused)');
  assert(A.tables.length === 1 && B.tables.length === 1, 'nothing changed: nothing re-sent (as before)');
  // Two pools move: only their routes are built again; the table matches the old builder's.
  uA.bump(2); uB.bump(2); uA.bump(7); uB.bump(7);
  const b1 = uA.builds();
  await A.te.refreshTable(); await B.te.refreshTable();
  assert(uA.builds() - b1 === 8 && A.te.tableInfo().reused === 40, `two pools moved: only their 8 routes built again (built ${uA.builds() - b1})`);
  assert(heldTable(A.tables) === heldTable(B.tables), 'after the change: the sidecar holds exactly the old builder\'s table');
  assert(A.tables.length === 2 && Object.keys(A.tables[1].pools).length === 2, 'only the 2 changed pools were sent');
  // Reuse expires: everything rebuilt after TRIG_ENTRY_TABLE_REUSE_MS.
  const C = entryWith(universe(3, 0), true, 1);
  await C.te.refreshTable(); await new Promise((r) => setTimeout(r, 5));
  await C.te.refreshTable();
  assert(C.te.tableInfo().reused === 0, 'older than TRIG_ENTRY_TABLE_REUSE_MS: built again');
  assert(entrySettings({}, 0.25).tableReuseMs === 5_000 && entrySettings({ TRIG_ENTRY_TABLE_REUSE_MS: '0' }, 0.25).tableReuseMs === 0, 'TRIG_ENTRY_TABLE_REUSE_MS: default 5000, 0 = off');

  // BENCH (TEST numbers): 150 pools x 4 routes, each build ~0.5 ms (like buildCheck), 10 pools move per second.
  const uR = universe(150, 0.5), uO = universe(150, 0.5);
  const R = entryWith(uR, true, 5_000), O = entryWith(uO, false, 0);
  await R.te.refreshTable(); await O.te.refreshTable();
  for (let i = 0; i < 10; i++) { uR.bump(i * 13); uO.bump(i * 13); }
  let t = performance.now(); await R.te.refreshTable(); const reuseMs = performance.now() - t;
  t = performance.now(); await O.te.refreshTable(); const oldMs = performance.now() - t;
  console.log(`[bench, TEST numbers] one-trip table rebuild, 150 pools / 600 routes, 10 pools moved: before ${oldMs.toFixed(0)} ms of work, now ${reuseMs.toFixed(0)} ms (${R.te.tableInfo().reused} routes reused)`);
  assert(reuseMs < oldMs / 3 && heldTable(R.tables) === heldTable(O.tables), 'rebuild is several times cheaper and the table is the same');
}

// ---- 4b. long-code list: never renumbered under rows that use it ----------------------------------
// The sidecar's rule (sim/src/check/entry.rs apply_table / call_for): every
// table message REPLACES its code list when the list is non-empty or the
// table is full; each row's "$code:<n>" is looked up in the newest list.
function sidecarCodesOk(tables: Array<Record<string, any>>, expected: (rid: string) => string): { rows: number; bad: number; codes: number } {
  const pools: Record<string, any[]> = {};
  let codes: string[] = [];
  for (const t of tables) {
    if (t.full) for (const k of Object.keys(pools)) delete pools[k];
    if (t.full || (t.codes ?? []).length) codes = t.codes;
    for (const [k, v] of Object.entries(t.pools as Record<string, any>)) { if (v === null) delete pools[k]; else pools[k] = v; }
  }
  let rows = 0, bad = 0;
  for (const list of Object.values(pools)) for (const r of list) {
    if (!r.c) continue;
    rows++;
    for (const acct of Object.values(r.c.overrides as Record<string, any>)) {
      const m = /^\$code:(\d+)$/.exec(acct.code ?? '');
      const code = m ? codes[Number(m[1])] : acct.code;
      if (code !== expected(r.rid)) bad++;
    }
  }
  return { rows, bad, codes: codes.length };
}
async function codeListTests() {
  // 12 pools, each route's pretend state holds a contract code of its own pool
  // (12 different long codes; the old builder emptied its list at the 9th).
  const u = universe(12, 0);
  const X = entryWith(u, true, 5_000);
  let version = 0;
  const peerAddr = '0x' + 'b2'.repeat(20);
  const ownPool = (rid: string) => rid.split(':')[0].split('>').find((a) => a !== peerAddr)!;
  const codeOf = (pool: string) => '0x' + (pool.slice(-4) + version.toString(16).padStart(2, '0')).repeat(60);
  const ACCT = '0x' + '5c'.repeat(20);
  // The real capture writes our check question down via the sidecar; here
  // it is replaced by one that puts the route's own code in the pretend state.
  (X.tf as any).capture = async (q: any) => {
    const pool = q.trade.hops.map((h: any) => h.pool).find((a: string) => a !== peerAddr);
    const data = '0x12345678' + q.trade.amountIn.toString(16).padStart(64, '0');
    return { calls: [{ to: ACCT, data }], overrides: { [ACCT]: { code: codeOf(pool) } }, data };
  };
  const expected = (rid: string) => codeOf(ownPool(rid));
  await X.te.refreshTable();
  let r = sidecarCodesOk(X.tables, expected);
  assert(r.rows === 48 && r.bad === 0, `12 different codes in one rebuild: every row's code resolves to its own contract (rows ${r.rows}, wrong ${r.bad}; the old builder got rows wrong here)`);
  // Every code changes (e.g. a contract upgrade): the old 12 are no longer
  // used, so the list is tidied after the build and the table re-sent whole.
  version = 1;
  (X.te as any).capCache.clear();
  (X.te as any).tblMemo.clear();
  for (let i = 0; i < 12; i++) u.bump(i);
  await X.te.refreshTable();
  r = sidecarCodesOk(X.tables, expected);
  assert(r.bad === 0 && r.codes === 12 && X.tables[X.tables.length - 1].full === true, `codes replaced: unused ones dropped, rows renumbered, full table sent (codes held ${r.codes}, wrong ${r.bad})`);
  // Nothing changed afterwards: the next rebuild keeps everything right.
  await X.te.refreshTable();
  r = sidecarCodesOk(X.tables, expected);
  assert(r.bad === 0, 'next rebuild: still every row right');
}

// ---- 5. freeze profile ----------------------------------------------------------------------------
async function profileTests() {
  const s = freezeProfileSettings({});
  assert(s.enabled && s.freezeMs === 200 && s.count === 3 && s.windowMs === 60_000 && s.seconds === 5 && s.everyMs === 30 * 60_000 && s.keep === 5 && s.dir === 'data/profiles', 'defaults: on, 3 freezes over 200 ms within 60 s, 5 s profile, at most every 30 min, keep 5');
  assert(!freezeProfileSettings({ FREEZE_PROFILE: '0' }).enabled, 'FREEZE_PROFILE=0 turns it off');

  // Self time from a tiny hand-made profile.
  const prof: CpuProfile = {
    startTime: 0, endTime: 10_000,
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
      { id: 2, callFrame: { functionName: 'keccak', url: 'file:///app/node_modules/x/sha3.js', lineNumber: 119 } },
      { id: 3, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
      { id: 4, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
    ],
    samples: [2, 2, 2, 4, 3], timeDeltas: [0, 2_000, 2_000, 2_000, 2_000],
  };
  const top = topSelfTime(prof);
  assert(top.list[0].name === 'keccak (sha3.js:120)' && Math.round(top.list[0].ms) === 6 && top.list[1].name === '(garbage collector)' && !top.list.some((x) => x.name === '(idle)'), 'top self time: grouped by function + file:line, idle left out');

  // Trigger rule with a fake clock and recorder.
  let now = Date.parse('2026-10-23T00:00:00Z');
  const logs: string[] = [];
  let recorded = 0;
  const dir = mkdtempSync(join(tmpdir(), 'profiles-'));
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, `cpu-2026-01-0${i}T00-00-00-000Z.cpuprofile`), '{}');
  const fp = new FreezeProfiler({ settings: { ...s, dir }, now: () => now, log: (m) => logs.push(m), record: async () => { recorded++; return prof; } });
  assert(!fp.noteFreeze(150) && !fp.noteFreeze(250) && !fp.noteFreeze(300), 'short freezes, or fewer than 3 long ones: no profile');
  now += 61_000;
  assert(!fp.noteFreeze(250), 'long freezes spread over more than 60 s: no profile');
  now += 1_000; assert(!fp.noteFreeze(260), 'two in the window: not yet');
  now += 1_000; assert(fp.noteFreeze(630), 'third long freeze within 60 s: profile starts');
  await new Promise((r) => setTimeout(r, 200));
  assert(recorded === 1 && logs.some((l) => l.startsWith('[freeze-profile]') && l.includes('keccak (sha3.js:120)') && l.includes('worst 630 ms')), 'one plain log line with the top functions');
  const files = readdirSync(dir).filter((f) => f.endsWith('.cpuprofile'));
  assert(files.length === 5 && !files.includes('cpu-2026-01-00T00-00-00-000Z.cpuprofile'), 'profile saved, only the newest 5 kept');
  for (let i = 0; i < 5; i++) { now += 1_000; fp.noteFreeze(900); }
  assert(recorded === 1, 'at most one profile per 30 min');
  now += 30 * 60_000;
  fp.noteFreeze(900); fp.noteFreeze(900);
  assert(fp.noteFreeze(900), 'after 30 min a new one may start');

  // The real profiler, 1 s, while a named busy function runs.
  const p = recordCpuProfile(1, 1_000);
  function slowHashingForTest() { const end = Date.now() + 700; let x = 0; for (let i = 0; ; i++) { x += Math.sqrt(i + x); if ((i & 0xffff) === 0 && Date.now() >= end) break; } return x; }
  await new Promise((r) => setTimeout(r, 50));
  slowHashingForTest();
  const real = topSelfTime(await p);
  console.log(`[freeze profile, TEST] real 1 s profile top: ${real.list.slice(0, 3).map((f) => `${f.name} ${Math.round(f.ms)} ms`).join(', ')}`);
  assert(real.list.some((f) => f.name.startsWith('slowHashingForTest') && f.ms > 250), 'the real profiler finds the busy function');
  const saved = JSON.parse(readFileSync(join(dir, readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')).sort().pop()!), 'utf8'));
  assert(Array.isArray(saved.nodes) && Array.isArray(saved.samples), 'saved file is a normal .cpuprofile');
}

async function main() {
  await feedTests();
  await stallTests();
  await tableTests();
  await codeListTests();
  await profileTests();
}
main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
