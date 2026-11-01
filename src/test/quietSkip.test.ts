import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import {
  TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings, poolShapeKey, poolPriceKey, tableQuietOn, QUIET_TURN_DIV,
} from '../execution/trigEntry';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient, frame, framePieces } from '../execution/localSim';
import { planExecuteCall } from '../execution/executorCalldata';
import { setFeeFromEvents } from '../core/eventFees';

// ============================================================================
// QUIET SKIP (Nov 1, TRIG_TABLE_QUIET, default on; 0 = exactly the #260 fast table).
//
// Plain English: after #260 went live, "pools not rebuilt" stayed at 0 and
// the table still took 52 to 65 s. Measured on the server: a pass starts
// every 10 s (TRIG_ENTRY_TABLE_MS=10000) and takes ~55 s while nothing is
// skipped, but a skipped pool only counted as good for 5 to 10 s and a kept
// question for 30 s. And 92 Algebra / hooked V4 pools get a new "fee read
// at" stamp on every 5 s re-read, so they and every pool sharing their coin
// pair (811 of 1,693) looked changed every time. These checks rebuild that
// live condition (pretend clock, 10 s passes, every pool re-read with new
// stamps every pass, gas and WETH price moving every pass, ~2 trades per
// pass) and prove:
//   1. The live failure: with TRIG_TABLE_QUIET=0 (the #260 code) not one
//      pool is skipped, nothing is held back as drift, and every pass sends
//      the table again (as live).
//   2. With the quiet skip on, same condition: nearly every pool is skipped,
//      only the pair that traded is re-listed, inside it only the routes
//      through the pool that traded are rebuilt, and far fewer messages go
//      to arbsim.
//   3. Nothing real is lost: with gas and coin price held still, what arbsim
//      holds is EXACTLY a fresh full build after every pass (trades,
//      re-reads, stamps, a slow pass included).
//   4. A slow pass (55 s, as live) does not make the next pass rebuild
//      everything: quiet turns are capped per pass, and every quiet pool
//      still gets its full rebuild within the quiet window.
//   5. A coin that gets blocked drops out on the very next pass.
//   6. The price key: ignores fee-read stamps, still sees prices, and sees
//      a stamp that changes which fee the maths uses (event fee).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const USDG = '0x' + '11'.repeat(20);
const WETH = '0x' + '22'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const poolAddr = (i: number) => '0x' + (0xb000 + i).toString(16).padStart(40, '0');
const coinAddr = (g: number) => '0x' + (0xe000 + g).toString(16).padStart(40, '0');

// The sidecar: answers balance-slot lookups, records every table message
// as the bytes the socket would get.
function fakeClient() {
  const frames: Buffer[] = [];
  let id = 0;
  const client: Record<string, unknown> = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Record<string, any>) => {
      if (m.type === 'trig_table') { frames.push(frame({ ...m, id: ++id })); return { ok: true, gen: m.gen }; }
      if (m.type === 'call' && m.calls?.[0]?.data?.startsWith('0x70a08231')) {
        const sd = m.overrides?.[m.calls[0].to]?.stateDiff ?? {};
        const v = Object.values(sd)[0] as string | undefined;
        return { id: m.id, ok: true, results: [{ success: true, output: v ?? '0x' + '0'.repeat(64), gasUsed: '0x1' }] };
      }
      return { id: m.id, ok: false, unknown: 'bad_request' };
    },
    requestBytes: async (open: Buffer[]) => { frames.push(framePieces(open, `,"id":${++id}}`)); return { ok: true }; },
  };
  return { client: client as unknown as LocalSimClient, frames };
}
const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 1, forwarder: { newestBlock: () => 1, txBlockOf: () => null } };

// A live-shaped universe: coin pairs of `per` pools (V2 / V3). In every
// other pair the first pool is "stamped" (as Algebra / hooked V4 live): each
// re-read gives it a new feeReadMs / feeReadBlock, nothing else moves.
type St = Record<string, any>;
function universe(groups: number, per: number, quietKeys: boolean) {
  const pools = Array.from({ length: groups * per }, (_, i) => {
    const g = Math.floor(i / per);
    return { addr: poolAddr(i), g, start: g % 2 === 0 ? USDG : WETH, mid: coinAddr(g), kind: i % 2 ? 'v3' : 'v2', stamped: i % per === 0 && g % 2 === 0 };
  });
  const stateOf = (i: number, v: number): St => {
    const p = pools[i];
    return {
      chain: 'robinhood', poolAddress: p.addr, dex: p.kind === 'v3' ? 'uniswap-v3' : 'uniswap-v2', poolType: p.kind, tokenA: p.start, tokenB: p.mid, feeBps: 30,
      sqrtPriceX96: 79228162514264337593543950336n + BigInt(v * 997 + i), liquidity: 10n ** 21n, tick: 0, reserveA: 10n ** 24n, reserveB: 10n ** 24n + BigInt(v * 1000),
      lastUpdatedMs: v, lastUpdatedBlock: v,
    };
  };
  const ver = pools.map(() => 0);
  const states: St[] = pools.map((_, i) => stateOf(i, 0));
  const blocked = new Set<string>();
  let px = 3456.78, gas = 0.0123, stamp = 0, listed = 0, builds = 0;
  const peers = (i: number) => { const out: number[] = []; for (let j = pools[i].g * per; j < (pools[i].g + 1) * per; j++) if (j !== i) out.push(j); return out; };
  const pk = (s: St) => poolPriceKey(s, quietKeys);
  const candOf = (bi: number, si: number): EntryCandidate => {
    const buy = pools[bi], sell = pools[si];
    const usdg = buy.start === USDG, dec = usdg ? 6 : 18, p = usdg ? 1 : px;
    const bs = states[bi], ss = states[si], g = gas;
    return {
      label: `Q${buy.g}/${usdg ? 'USDG' : 'WETH'} ${buy.addr.slice(-4)}>${sell.addr.slice(-4)}`, buyPool: buy.addr, sellPool: sell.addr, tokenIn: buy.start, tokens: [buy.start, buy.mid],
      keys: usdg ? [buy.addr, sell.addr] : [buy.addr, sell.addr, LENDER], maxSizeUsd: 400, gasUsd: g,
      build: (usd) => {
        builds++;
        const b = planExecuteCall({ chain: 'robinhood', tokenIn: buy.start, buyPool: bs as any, sellPool: ss as any, tradeSizeUsd: usd, netProfitUsd: 1, usdPerTokenIn: p, tokenInDecimals: dec, maxBlock: 0n, v3Lender: usdg ? undefined : LENDER });
        return b.ok ? { trade: { token: buy.start, amountIn: b.amountIn, hops: b.hops }, simOpts: { v3Lender: usdg ? undefined : LENDER, weth: WETH } } : null;
      },
      usdOf: (u) => Number(u) / 10 ** dec * p,
      fx: { px: p, d: dec, lp: usdg ? 0 : 500 },
    };
  };
  // As shadowMain's entryTableRoutes / entryPoolVer (coin rule + prices of the pool and its pair).
  const table = (): TablePool[] => pools.map((p, i) => ({
    pool: p.addr,
    ver: () => { const v: unknown[] = [!blocked.has(p.mid), pk(states[i])]; for (const j of peers(i)) v.push(pools[j].addr, pk(states[j])); return v; },
    routes: (): TableRoute[] => {
      listed++;
      if (blocked.has(p.mid)) return [];
      const out: TableRoute[] = [];
      for (const j of peers(i)) for (const [b, s] of [[i, j], [j, i]]) {
        const usdg = pools[b].start === USDG, pxNow = usdg ? 1 : px, dec = usdg ? 6 : 18;
        const score = Number((BigInt(states[b].reserveB) - BigInt(states[s].reserveB)) % 1000n) / 100 + (usdg ? 0 : px / 1e5);
        out.push({
          rid: `${pools[b].addr}>${pools[s].addr}:${pools[b].start}`, held: true, score, build: () => candOf(b, s),
          inputs: () => [poolShapeKey(states[b]), poolShapeKey(states[s]), pxNow, dec, Infinity, 0, false],
          live: [pk(states[b]), states[b].observedFee, pk(states[s]), states[s].observedFee],
        });
      }
      return out;
    },
  }));
  // One live pass worth of change: every pool re-read (new object, same
  // price; stamped pools get a new stamp), `trades` pools trade, gas and
  // the WETH price move unless held still.
  const tick = (r: number, opts: { trades?: number[]; drift?: boolean } = {}) => {
    stamp++;
    for (let i = 0; i < states.length; i++) states[i] = { ...states[i], lastUpdatedMs: states[i].lastUpdatedMs + 1, ...(pools[i].stamped ? { feeReadMs: 1_000_000 + stamp, feeReadBlock: stamp } : {}) };
    for (const i of opts.trades ?? []) { ver[i]++; states[i] = stateOf(i, ver[i]); }
    if (opts.drift ?? true) { gas = Math.round(gas * (r % 2 ? 1.013 : 0.99) * 1e6) / 1e6; px = Math.round(px * (r % 3 ? 1.0007 : 0.9995) * 100) / 100; }
  };
  return { table, tick, pools, blocked, listed: () => listed, builds: () => builds, routes: groups * per * (per - 1) * 2, n: pools.length };
}

function entryWith(env: Record<string, string>, src: () => TablePool[], clock: { t: number }) {
  const { client, frames } = fakeClient();
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'quiet-')), 'x.jsonl'), 1_000_000, 0);
  const tf = new TriggerFirst({ client, settings: trigFirstSettings(env), copy2: () => copy2, shadowLog: log, hostOn: () => true, log: () => {} });
  const te = new TrigEntry({
    tf, client, shadowLog: log, settings: entrySettings(env, 0.1),
    candidatesFor: () => ({ cands: [], found: 0 }), tableRoutes: src,
    isOurTx: () => false, ourAddresses: [], killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => ({}), log: () => {}, lag: () => 0, now: () => clock.t,
  });
  return { te, frames, T: () => (te as any).tbl };
}
// What arbsim holds after these messages (pool -> rows without ids).
function held(frames: Buffer[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of frames) {
    const msg = JSON.parse(f.subarray(4).toString('utf8'));
    if (msg.full) m.clear();
    for (const [k, v] of Object.entries(msg.pools as Record<string, unknown>)) {
      if (v === null) m.delete(k);
      else m.set(k, JSON.stringify((v as Array<Record<string, unknown>>).map(({ e: _e, ...row }) => row)));
    }
  }
  return m;
}
const sameTable = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

async function main() {
  // Live settings (two steps, the bot does not ask), live pass every 10 s, live kept-question window.
  const live = { LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0', FASTLANE: 'live', TRIG_ENTRY_NODE_ASKS: 'off', TRIG_ENTRY_TABLE_MAX_BYTES: '60000', TRIG_ENTRY_TABLE_REUSE_MS: '30000' };
  const GROUPS = 12, PER = 5;

  // ---- settings ----
  assert(tableQuietOn({}) && !tableQuietOn({ TRIG_TABLE_QUIET: '0' }) && !tableQuietOn({ TRIG_TABLE_FAST: '0' }), 'TRIG_TABLE_QUIET: on by default; 0 (or the fast table off) = #260 / old code');
  assert(entrySettings({}).tableQuietMs === 600_000 && entrySettings({ TRIG_TABLE_QUIET_MS: '20000' }).tableQuietMs === 20_000, 'quiet window 10 min by default, settable');

  // ---- 6. price key ----
  {
    const p = { chain: 'robinhood', poolAddress: poolAddr(1), dex: 'algebra', poolType: 'v3', variant: 'algebra', tokenA: USDG, tokenB: WETH, feeBps: 5, feePips: 500, sqrtPriceX96: 5n, liquidity: 7n, feeReadMs: 100, feeReadBlock: 10 };
    const restamped = { ...p, feeReadMs: 200, feeReadBlock: 20 };
    assert(poolPriceKey(p) !== poolPriceKey(restamped), '#260 price key changes on a new fee-read stamp alone (the live problem)');
    assert(poolPriceKey(p, true) === poolPriceKey(restamped, true), 'quiet price key: a new fee-read stamp alone changes nothing');
    assert(poolPriceKey(p, true) !== poolPriceKey({ ...p, sqrtPriceX96: 6n }, true) && poolPriceKey(p, true) !== poolPriceKey({ ...p, feePips: 600 }, true), 'quiet price key: still sees a price or fee change');
    // A swap event fee (block 15) counts while the last fee read is older
    // (block 10), not after a newer read (block 20): the key must see that.
    setFeeFromEvents(true, { now: () => 1_000 });
    const obs = { z: { pips: 900, block: 15, atMs: 1_000 }, o: { pips: 900, block: 15, atMs: 1_000 } };
    const a = poolPriceKey({ ...p, observedFee: obs }, true), b = poolPriceKey({ ...restamped, observedFee: obs }, true);
    setFeeFromEvents(false);
    assert(a !== b && a.includes('e900'), `quiet price key: sees a stamp that changes which fee the maths uses (${a.slice(-12)} vs ${b.slice(-12)})`);
  }

  // ---- 1 and 2. the live condition, #260 vs quiet skip ----
  const runLive = async (quiet: boolean) => {
    const u = universe(GROUPS, PER, quiet);
    const c = { t: 1_000_000 };
    const env = { ...live, TRIG_TABLE_QUIET: quiet ? '1' : '0' };
    const E = entryWith(env, u.table, c);
    await E.te.refreshTable();
    const sent0 = E.frames.length, b0 = u.builds(), l0 = u.listed();
    let skipped = 0, held2 = 0, kept = 0, reused = 0, passes = 0, quietPassSends = 0;
    for (let r = 0; r < 12; r++) {
      // ~2 trades per 10 s pass live; every 3rd pass none.
      const trades = r % 3 === 2 ? [] : [(r * 7 + 3) % u.n];
      u.tick(r, { trades });
      c.t += 10_000;
      const before = E.frames.length;
      await E.te.refreshTable();
      if (!trades.length) quietPassSends += E.frames.length - before;
      skipped += E.T().lastSkipped; held2 += E.T().lastHeld; kept += E.T().lastKeptRoutes; reused += E.te.tableInfo().reused; passes++;
    }
    const totalBytes = E.frames.slice(sent0).reduce((a, f) => a + f.length, 0);
    return { u, E, skipped: skipped / passes, held: held2, kept: kept / passes, reused: reused / passes, msgs: E.frames.length - sent0, bytes: totalBytes, builds: u.builds() - b0, listed: u.listed() - l0, quietPassSends };
  };
  const old = await runLive(false), neu = await runLive(true);
  assert(old.skipped === 0 && old.held === 0, `live condition, #260 code (TRIG_TABLE_QUIET=0): pools not rebuilt ${old.skipped} per pass, drift held back ${old.held} (live: 0 and 0)`);
  assert(old.msgs >= 12 && old.quietPassSends > 0, `live condition, #260 code: the table goes out every pass, even with no trade (${old.msgs} messages in 12 passes, ${old.quietPassSends} in passes with no trade)`);
  assert(neu.skipped >= 0.85 * neu.u.n, `quiet skip: ${neu.skipped.toFixed(1)} of ${neu.u.n} pools not rebuilt per pass (was ${old.skipped})`);
  assert(neu.reused >= 0.95 * neu.u.routes, `quiet skip: ${Math.round(neu.reused)} of ${neu.u.routes} routes reused per pass (was ${Math.round(old.reused)})`);
  assert(neu.kept > 0, `quiet skip: inside a re-listed pair, routes not through the pool that traded keep their row (${neu.kept.toFixed(1)} per pass)`);
  assert(neu.quietPassSends === 0, `quiet skip: a pass with no trade sends nothing (was ${old.quietPassSends} messages)`);
  assert(neu.msgs * 3 <= old.msgs && neu.bytes * 5 <= old.bytes, `quiet skip: messages to arbsim ${old.msgs} -> ${neu.msgs}, bytes ${old.bytes} -> ${neu.bytes}`);
  assert(neu.builds * 5 <= old.builds && neu.listed * 5 <= old.listed, `quiet skip: trades built ${old.builds} -> ${neu.builds}, pools listed ${old.listed} -> ${neu.listed}`);

  // ---- 3. nothing real is lost: arbsim holds exactly a fresh full build ----
  {
    // Gas and coin price held still, so the only differences a fresh build
    // could show are real ones (trades, re-reads, stamps, a slow pass).
    const u = universe(GROUPS, PER, true), uRef = universe(GROUPS, PER, true);
    const c = { t: 1_000_000 }, cRef = { t: 1_000_000 };
    const env = { ...live };
    const envRef = { ...live, TRIG_TABLE_FAST: '0' }; // the old full rebuild, every route every pass
    const N = entryWith(env, u.table, c), R = entryWith(envRef, uRef.table, cRef);
    await N.te.refreshTable(); await R.te.refreshTable();
    let allSame = true, checked = 0;
    for (let r = 0; r < 16; r++) {
      const trades = r % 4 === 3 ? [] : [(r * 11 + 2) % u.n, (r * 5 + 9) % u.n];
      u.tick(r, { trades, drift: false }); uRef.tick(r, { trades, drift: false });
      const step = r === 6 ? 55_000 : 10_000; // one slow pass, as live
      c.t += step; cRef.t += step;
      await N.te.refreshTable(); await R.te.refreshTable();
      const a = held(N.frames), b = held(R.frames);
      checked++;
      if (!sameTable(a, b)) { allSame = false; console.error(`  pass ${r}: arbsim's table differs from a fresh build`); }
    }
    assert(allSame, `after every one of ${checked} passes (trades, re-reads, new stamps, one 55 s pass) arbsim holds exactly what a fresh full build gives`);
  }

  // ---- 4. a slow pass doesn't trigger a full rebuild; every quiet pool still gets its turn ----
  {
    const u = universe(GROUPS, PER, true);
    const c = { t: 1_000_000 };
    const env = { ...live, TRIG_TABLE_QUIET_MS: '60000' };
    const N = entryWith(env, u.table, c);
    await N.te.refreshTable();
    const cap = Math.ceil(u.n / QUIET_TURN_DIV);
    // The first build took 55 s (live); then 10 s passes with no trades.
    let maxTurns = 0, maxListed = 0;
    const listedPer: number[] = [];
    for (let r = 0; r < 20; r++) {
      u.tick(r, { trades: [] });
      c.t += r === 0 ? 55_000 : 10_000;
      const l = u.listed();
      await N.te.refreshTable();
      listedPer.push(u.listed() - l);
      maxTurns = Math.max(maxTurns, N.T().lastTurns); maxListed = Math.max(maxListed, u.listed() - l);
    }
    assert(listedPer[0] <= cap, `a 55 s pass, then nothing traded: the next pass re-lists only its capped quiet turns (${listedPer[0]} of ${u.n}; #260 re-listed all ${u.n})`);
    assert(maxTurns <= cap && maxListed <= cap, `quiet turns never more than 1 in ${QUIET_TURN_DIV} pools per pass (most ${maxTurns} turns / ${maxListed} listed; cap ${cap})`);
    const seen = new Set<string>();
    // Which pools got their full rebuild: count from the pool records' clocks.
    for (const [k, v] of (N.te as any).poolPass as Map<string, { at: number }>) if (v.at > 1_000_000) seen.add(k);
    assert(seen.size === u.n, `within 2 x the quiet window (200 s) every quiet pool was fully rebuilt (${seen.size} of ${u.n})`);
  }

  // ---- 7. drift (gas / WETH price) still reaches arbsim: on each pool's turn ----
  {
    // Gas and WETH price move for 10 passes with a trade now and then, then
    // stop. Once every pool has had its quiet turn (window 60 s, so all
    // within 2 x 60 s), arbsim must hold EXACTLY a fresh full build, drift
    // included: nothing is held back for good.
    const u = universe(GROUPS, PER, true), uRef = universe(GROUPS, PER, true);
    const c = { t: 1_000_000 }, cRef = { t: 1_000_000 };
    const env = { ...live, TRIG_TABLE_QUIET_MS: '60000' }, envRef = { ...live, TRIG_TABLE_FAST: '0' };
    const N = entryWith(env, u.table, c), R = entryWith(envRef, uRef.table, cRef);
    await N.te.refreshTable(); await R.te.refreshTable();
    let differsMid = false;
    for (let r = 0; r < 30; r++) {
      const o = { trades: r % 4 === 1 && r < 10 ? [(r * 13) % u.n] : [], drift: r < 10 };
      u.tick(r, o); uRef.tick(r, o);
      c.t += 10_000; cRef.t += 10_000;
      await N.te.refreshTable(); await R.te.refreshTable();
      if (r === 10 && !sameTable(held(N.frames), held(R.frames))) differsMid = true;
    }
    assert(differsMid, 'drift of pools that did not trade waits (right after the moves, arbsim still has older stop amounts for some pools)');
    assert(sameTable(held(N.frames), held(R.frames)), `after every pool's quiet turn arbsim holds exactly the fresh full build, drift included (${held(N.frames).size} pools)`);
  }

  // ---- 5. a blocked coin drops out on the next pass ----
  {
    const u = universe(GROUPS, PER, true);
    const c = { t: 1_000_000 };
    const N = entryWith({ ...live }, u.table, c);
    await N.te.refreshTable();
    u.tick(0, { trades: [] }); c.t += 10_000; await N.te.refreshTable();
    const coin = u.pools[PER].mid; // pair 1
    u.blocked.add(coin);
    u.tick(1, { trades: [] }); c.t += 10_000; await N.te.refreshTable();
    const a = held(N.frames);
    const left = u.pools.filter((p) => p.mid === coin).map((p) => a.get(p.addr.toLowerCase())).filter((rows) => rows !== undefined && rows !== '[]');
    assert(left.length === 0, `a coin blocked between passes: its routes are gone from arbsim's table on the very next pass (${left.length} pools still with rows)`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
