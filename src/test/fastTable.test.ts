import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AbiCoder, keccak256 } from 'ethers';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import {
  TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings, stopUnits, splitTablePools, splitTablePoolsSliced,
  poolShapeKey, poolPriceKey, routeSpread, tableFastOn,
} from '../execution/trigEntry';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient, frame, framePieces } from '../execution/localSim';
import { buildExecuteCall, planExecuteCall, checkBuildEncodeOn } from '../execution/executorCalldata';

// ============================================================================
// FAST TABLE (Nov 1, TRIG_TABLE_FAST, default on; 0 = exactly as before).
//
// Plain English: the fast-lane table took ~70 s per rebuild live (the
// offline soak said ~0.5 s). The live bot builds every route's trade with
// the contract's calldata encoder (thrown away), its pools get new state
// objects all the time, and the gas cost moves every few seconds: so a
// kept question was never reusable and every pass rebuilt all ~37,000
// routes. These checks prove:
//   1. Every message to arbsim is EXACTLY the same, byte for byte, with the
//      fast table on (drift re-sends off) and off, over 40 rebuilds while
//      pool prices, the gas cost and the WETH price move, pools get new
//      objects, and the reuse window runs out (pretend clock).
//   2. The work really goes away: a pass where only pool objects were
//      replaced (same prices) or only gas moved writes no question again.
//   3. Drift (gas / coin price only) re-sends wait for TRIG_TABLE_DRIFT_MS,
//      a real price change goes at once, and what arbsim ends up holding is
//      exactly the fresh table.
//   4. Pools whose host facts (`ver`) did not move are not even listed.
//   5. Helpers: planExecuteCall = buildExecuteCall without the calldata (same
//      refusals), buildExecuteCall's calldata unchanged, the quick stop
//      amount = the old search, the sliced split = the old split, the
//      pre-written message bytes = the old message bytes, the pool keys.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const USDG = '0x' + '11'.repeat(20);
const WETH = '0x' + '22'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const PM = '0x' + '44'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);
const poolAddr = (i: number) => '0x' + (0xa000 + i).toString(16).padStart(40, '0');
const coinAddr = (g: number) => '0x' + (0xc000 + g).toString(16).padStart(40, '0');

// The sidecar as the table builder sees it: answers balance-slot lookups and
// records every table message as the exact bytes the socket would get.
function fakeClient(withBytes: boolean) {
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
  };
  if (withBytes) client.requestBytes = async (open: Buffer[]) => { frames.push(framePieces(open, `,"id":${++id}}`)); return { ok: true }; };
  return { client: client as unknown as LocalSimClient, frames };
}
const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 1, forwarder: { newestBlock: () => 1, txBlockOf: () => null } };

// A live-shaped universe: V2 / V3 / V4 pools with real-looking state
// objects (replaced on every change, as the pool cache does), trades built
// with the real calldata planner, a gas cost and a WETH price that move.
type St = Record<string, any>;
function universe(groups: number, per: number) {
  const pools = Array.from({ length: groups * per }, (_, i) => {
    const g = Math.floor(i / per), kind = (['v2', 'v3', 'v4'] as const)[i % 3];
    const start = g % 2 === 0 ? USDG : WETH, mid = coinAddr(g);
    const addr = kind === 'v4' ? keccak256(AbiCoder.defaultAbiCoder().encode(['uint256'], [i])) : poolAddr(i);
    return { addr, g, start, mid, kind };
  });
  const stateOf = (i: number, v: number): St => {
    const p = pools[i];
    return {
      chain: 'robinhood', poolAddress: p.addr, dex: p.kind === 'v4' ? 'uniswap-v4' : p.kind === 'v3' ? 'uniswap-v3' : 'uniswap-v2', poolType: p.kind === 'v2' ? 'v2' : 'v3',
      tokenA: p.start, tokenB: p.mid, feeBps: 30, sqrtPriceX96: 79228162514264337593543950336n + BigInt(v * 997 + i), liquidity: 10n ** 21n, tick: 0,
      reserveA: 10n ** 24n, reserveB: 10n ** 24n + BigInt(v * 1000), lastUpdatedMs: v, lastUpdatedBlock: v,
      ...(p.kind === 'v4' ? { v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: PM, stateView: PM, hooks: ZERO } } : {}),
    };
  };
  const ver = pools.map(() => 0);
  const states: St[] = pools.map((_, i) => stateOf(i, 0));
  let px = 3456.78, gas = 0.0123;
  const peers = (i: number) => { const out: number[] = []; for (let j = pools[i].g * per; j < (pools[i].g + 1) * per; j++) if (j !== i) out.push(j); return out; };
  const candOf = (bi: number, si: number): EntryCandidate => {
    const buy = pools[bi], sell = pools[si];
    const usdg = buy.start === USDG, dec = usdg ? 6 : 18, p = usdg ? 1 : px;
    const bs = states[bi], ss = states[si], g = gas;
    return {
      label: `C${buy.g}/${usdg ? 'USDG' : 'WETH'} ${buy.addr.slice(-4)}>${sell.addr.slice(-4)}`, buyPool: buy.addr, sellPool: sell.addr, tokenIn: buy.start, tokens: [buy.start, buy.mid],
      keys: usdg ? [buy.addr, sell.addr] : [buy.addr, sell.addr, LENDER], maxSizeUsd: 400, gasUsd: g,
      // As shadowMain's buildCheck (the calldata switch follows TRIG_TABLE_FAST).
      build: (usd) => {
        builds++;
        const input = { chain: 'robinhood' as const, tokenIn: buy.start, buyPool: bs as any, sellPool: ss as any, tradeSizeUsd: usd, netProfitUsd: 1, usdPerTokenIn: p, tokenInDecimals: dec, maxBlock: 0n, v3Lender: usdg ? undefined : LENDER };
        const b = checkBuildEncodeOn() ? buildExecuteCall(input) : planExecuteCall(input);
        return b.ok ? { trade: { token: buy.start, amountIn: b.amountIn, hops: b.hops }, simOpts: { v3Lender: usdg ? undefined : LENDER, weth: WETH } } : null;
      },
      usdOf: (u) => Number(u) / 10 ** dec * p,
      fx: { px: p, d: dec, lp: usdg ? 0 : 500 },
    };
  };
  let listed = 0, builds = 0;
  // Like shadowMain's entryTableRoutes: fast = trading details + live prices, else the state objects.
  const table = (fast: boolean, withVer: boolean) => (): TablePool[] => pools.map((p, i) => ({
    pool: p.addr,
    ...(fast && withVer ? { ver: () => { const v: unknown[] = [poolPriceKey(states[i])]; for (const j of peers(i)) v.push(poolPriceKey(states[j])); return v; } } : {}),
    routes: (): TableRoute[] => {
      listed++;
      const out: TableRoute[] = [];
      for (const j of peers(i)) for (const [b, s] of [[i, j], [j, i]]) {
        const usdg = pools[b].start === USDG, pxNow = usdg ? 1 : px, dec = usdg ? 6 : 18;
        const score = Number((BigInt(states[b].reserveB) - BigInt(states[s].reserveB)) % 1000n) / 100 + (usdg ? 0 : px / 1e5);
        out.push({
          rid: `${pools[b].addr}>${pools[s].addr}:${pools[b].start}`, held: (ver[b] + s) % 7 !== 0, score, build: () => candOf(b, s),
          inputs: fast ? () => [poolShapeKey(states[b]), poolShapeKey(states[s]), pxNow, dec, Infinity, 0, false] : [states[b], states[s], pxNow, dec],
          ...(fast ? { live: [poolPriceKey(states[b]), states[b].observedFee, poolPriceKey(states[s]), states[s].observedFee] } : {}),
        });
      }
      return out;
    },
  }));
  // One second: some pools trade (new price), or all pools re-read (new objects, same prices); gas / WETH price move.
  const tick = (r: number, opts: { trades?: boolean; reread?: boolean; gas?: boolean; px?: boolean } = {}) => {
    if (opts.reread ?? r % 4 === 3) for (let i = 0; i < states.length; i++) states[i] = { ...states[i], lastUpdatedMs: states[i].lastUpdatedMs + 1 };
    if (opts.trades ?? r % 4 !== 3) for (let i = 0; i < states.length; i++) if ((i * 31 + r * 17) % 13 === 0) { ver[i]++; states[i] = stateOf(i, ver[i]); }
    if (opts.gas ?? r % 2 === 0) gas = Math.round(gas * 1.013 * 1e6) / 1e6;
    if (opts.px ?? r % 3 === 1) px = Math.round(px * 1.0007 * 100) / 100;
  };
  return { table, tick, listed: () => listed, builds: () => builds, routes: groups * per * (per - 1) * 2, pools: pools.length, addrs: pools.map((p) => p.addr.toLowerCase()) };
}

function entryWith(env: Record<string, string>, src: () => TablePool[], clock: { t: number }, withBytes = true) {
  for (const k of ['TRIG_TABLE_FAST', 'TRIG_ENTRY_TABLE_LEAN']) { if (env[k] !== undefined) process.env[k] = env[k]; else delete process.env[k]; }
  const { client, frames } = fakeClient(withBytes);
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'fast-')), 'x.jsonl'), 1_000_000, 0);
  const tf = new TriggerFirst({ client, settings: trigFirstSettings(env), copy2: () => copy2, shadowLog: log, hostOn: () => true, log: () => {} });
  let captures = 0;
  const real = tf.capture.bind(tf);
  (tf as any).capture = (...a: Parameters<TriggerFirst['capture']>) => { captures++; return real(...a); };
  const te = new TrigEntry({
    tf, client, shadowLog: log, settings: entrySettings(env, 0.1),
    candidatesFor: () => ({ cands: [], found: 0 }), tableRoutes: src,
    isOurTx: () => false, ourAddresses: [], killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => ({}), log: () => {}, lag: () => 0, now: () => clock.t,
  });
  return { te, frames, captures: () => captures };
}
// One rebuild with the process settings of that instance (the calldata
// switch reads process.env, as in the bot).
async function pass(e: ReturnType<typeof entryWith>, env: Record<string, string>) {
  for (const k of ['TRIG_TABLE_FAST', 'TRIG_ENTRY_TABLE_LEAN']) { if (env[k] !== undefined) process.env[k] = env[k]; else delete process.env[k]; }
  await e.te.refreshTable();
}
// What arbsim holds after these messages (pool -> rows without ids), from the frames.
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

async function main() {
  const live = { LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0', FASTLANE: 'live', TRIG_ENTRY_NODE_ASKS: 'off', TRIG_ENTRY_TABLE_MAX_BYTES: '60000' };

  // ---- 5. helpers ----
  assert(tableFastOn({}) && !tableFastOn({ TRIG_TABLE_FAST: '0' }) && !tableFastOn({ TRIG_ENTRY_TABLE_LEAN: '0' }), 'TRIG_TABLE_FAST: on by default; 0 (or the lean table off) = old');
  assert(entrySettings({}).tableDriftMs === 10_000 && entrySettings({ TRIG_TABLE_DRIFT_MS: '0' }).tableDriftMs === 0 && entrySettings({}).tableReuseMaxMs === 30_000, 'drift 10 s and reuse up to 30 s by default; drift 0 = send at once');
  {
    const u = universe(2, 3);
    const st = (u as any);
    void st;
    // planExecuteCall = buildExecuteCall minus data, refusals the same.
    const a = { chain: 'robinhood' as const, tokenIn: USDG, buyPool: { chain: 'robinhood', poolAddress: poolAddr(1), dex: 'uniswap-v3', poolType: 'v3', tokenA: USDG, tokenB: coinAddr(0), feeBps: 5 } as any, sellPool: { chain: 'robinhood', poolAddress: poolAddr(2), dex: 'uniswap-v2', poolType: 'v2', tokenA: coinAddr(0), tokenB: USDG, feeBps: 30 } as any, tradeSizeUsd: 400, netProfitUsd: 1, usdPerTokenIn: 1, tokenInDecimals: 6, maxBlock: 0n };
    const hooked = { chain: 'robinhood', poolAddress: '0x' + 'ab'.repeat(32), dex: 'uniswap-v4', poolType: 'v3', tokenA: USDG, tokenB: coinAddr(0), feeBps: 0, v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: PM, stateView: PM, hooks: '0x' + '55'.repeat(20) } } as any;
    const cases: Array<[string, any]> = [
      ['own money', a], ['flash loan', { ...a, v3Lender: LENDER }], ['aave', { ...a, flashPool: '0x' + 'ee'.repeat(20) }],
      ['lender is a trade pool', { ...a, v3Lender: poolAddr(1) }], ['unknown decimals', { ...a, tokenInDecimals: undefined }], ['zero size', { ...a, tradeSizeUsd: 0 }],
      ['hooked V4 key mismatch', { ...a, sellPool: { ...hooked, tokenA: coinAddr(0), tokenB: USDG } }], ['wrong coin', { ...a, tokenIn: WETH }],
      ['V4 hop', { ...a, sellPool: { ...hooked, v4: { ...hooked.v4, hooks: ZERO }, tokenA: coinAddr(0), tokenB: USDG } }],
    ];
    let same = true;
    for (const [name, input] of cases) {
      for (const fast of ['1', '0']) {
        process.env.TRIG_TABLE_FAST = fast;
        const b = buildExecuteCall(input), p = planExecuteCall(input);
        const { data: _d, ...rest } = (b.ok ? b : { ...b, data: '' }) as any;
        const pr = p.ok ? p : { ...p };
        if (JSON.stringify(rest, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) !== JSON.stringify(pr, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))) { same = false; console.error(`  differs: ${name} (fast ${fast})`); }
      }
      process.env.TRIG_TABLE_FAST = '0'; const old = buildExecuteCall(input);
      process.env.TRIG_TABLE_FAST = '1'; const neu = buildExecuteCall(input);
      if (JSON.stringify(old, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) !== JSON.stringify(neu, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))) { same = false; console.error(`  buildExecuteCall differs: ${name}`); }
    }
    delete process.env.TRIG_TABLE_FAST;
    assert(same, `planExecuteCall = buildExecuteCall without the calldata, and buildExecuteCall (calldata included) is the same with the switch on and off (${cases.length} cases incl. refusals)`);
  }
  {
    // The quick stop amount is the old search's answer.
    let bad = 0, n = 0;
    for (const [px, d] of [[1, 6], [3456.78, 18], [0.0000123, 18], [98765.4, 8], [1, 0], [2.5, 2]] as Array<[number, number]>) {
      for (const gas of [0, 0.0001, 0.0123, 0.05, 1.7, 33]) for (const min of [0, 0.1, 0.25]) {
        const c = { usdOf: (u: bigint) => Number(u) / 10 ** d * px, gasUsd: gas, fx: { px, d } } as unknown as EntryCandidate;
        n++;
        if (stopUnits(c, min, true) !== stopUnits(c, min)) bad++;
      }
    }
    assert(bad === 0, `stop amount: the direct answer equals the old search in all ${n} cases`);
  }
  {
    const pools: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) pools[poolAddr(i)] = i % 7 === 3 ? null : Array.from({ length: (i % 5) + 1 }, (_, j) => ({ rid: `r${i}.${j}`, s: i * 0.1, c: { x: 'é'.repeat(i * 50) } }));
    const codes = ['0x' + 'aa'.repeat(400)];
    const texts: Buffer[][] = [];
    const a = splitTablePools(pools, codes, 3_000);
    const b = await splitTablePoolsSliced(pools, codes, 3_000, () => null, texts);
    let bytesOk = a.length === texts.length;
    for (let i = 0; i < a.length && bytesOk; i++) {
      const msg = { type: 'trig_table', gen: 7 + i, full: i === 0, base: -1, codes: i === 0 ? codes : [], pools: a[i] };
      const open = Buffer.from(`{"type":"trig_table","gen":${msg.gen},"full":${msg.full},"base":${msg.base},"codes":${JSON.stringify(msg.codes)},"pools":{`, 'utf8');
      bytesOk = framePieces([open, ...texts[i], Buffer.from('}')], `,"id":${99 + i}}`).equals(frame({ ...msg, id: 99 + i }));
    }
    assert(a.length > 2 && JSON.stringify(a) === JSON.stringify(b), `sliced split = old split (${a.length} parts, removed pools and non-ASCII text included)`);
    assert(bytesOk, 'pre-written message bytes = JSON.stringify bytes, every part');
  }
  {
    const p = { chain: 'robinhood', poolAddress: poolAddr(1), dex: 'uniswap-v3', poolType: 'v3', tokenA: USDG, tokenB: WETH, feeBps: 5, sqrtPriceX96: 5n, liquidity: 7n, reserveA: 1n, lastUpdatedMs: 1 };
    assert(poolShapeKey(p) === poolShapeKey({ ...p, sqrtPriceX96: 6n, liquidity: 9n, lastUpdatedMs: 2 }) && poolShapeKey(p) !== poolShapeKey({ ...p, feeBps: 30 }) && poolShapeKey(p) !== poolShapeKey({ ...p, v4: { fee: 1, tickSpacing: 1, native: false, poolManager: PM, hooks: ZERO } }),
      'trading-details key: ignores price and time, sees fee and V4 key');
    assert(poolPriceKey(p) !== poolPriceKey({ ...p, sqrtPriceX96: 6n }) && poolPriceKey(p) === poolPriceKey({ ...p, lastUpdatedMs: 9 }), 'price key: sees price, ignores time');
    const sp = [routeSpread('a', 25_000), routeSpread('b', 25_000), routeSpread('a', 25_000)];
    assert(sp[0] === sp[2] && sp.every((x) => x >= 0 && x < 25_000) && routeSpread('a', 0) === 0, 'route spread: stable per route, inside its range');
  }

  // ---- 1. identical messages, fast on (drift re-sends off) vs off, 40 rebuilds ----
  for (const [name, extra] of [['live settings (two steps, bot does not ask)', {}], ['one trip, bot asks', { TRIG_ENTRY_ONE_TRIP: '1', TRIG_ENTRY_NODE_ASKS: 'on' }]] as const) {
    const uOld = universe(6, 4), uNew = universe(6, 4);
    const cO = { t: 1_000_000 }, cN = { t: 1_000_000 };
    const envO = { ...live, ...extra, TRIG_TABLE_FAST: '0' }, envN = { ...live, ...extra, TRIG_TABLE_DRIFT_MS: '0' };
    const O = entryWith(envO, uOld.table(false, false), cO);
    const N = entryWith(envN, uNew.table(true, false), cN);
    for (let r = 0; r < 40; r++) {
      uOld.tick(r); uNew.tick(r);
      cO.t += 1_000; cN.t += 1_000;
      await pass(O, envO); await pass(N, envN);
    }
    assert(O.frames.length > 40 && O.frames.length === N.frames.length, `${name}: same number of messages (${N.frames.length})`);
    assert(O.frames.every((f, i) => f.equals(N.frames[i])), `${name}: every message byte for byte the same with the fast table on and off`);
    assert(uOld.builds() > 3 * uNew.builds(), `${name}: and far fewer trades built (old ${uOld.builds()}, fast ${uNew.builds()})`);
  }

  // ---- 2. replaced objects / gas only: no question written again ----
  {
    const u = universe(10, 4);
    const c = { t: 1_000_000 };
    const env = { ...live, TRIG_TABLE_DRIFT_MS: '0' };
    const N = entryWith(env, u.table(true, false), c);
    await pass(N, env);
    const first = u.builds();
    u.tick(1, { trades: false, reread: true, gas: false, px: false }); c.t += 1_000; await pass(N, env);
    const afterReread = u.builds() - first;
    u.tick(2, { trades: false, reread: false, gas: true, px: false }); c.t += 1_000; await pass(N, env);
    const afterGas = u.builds() - first;
    const info = N.te.tableInfo();
    assert(first === u.routes / 2 && afterReread === 0 && afterGas === 0 && N.captures() > 0, `fast: first build ${first} trades (one per route); all pools re-read (new objects): ${afterReread} more; gas moved: ${afterGas} more`);
    assert(info.reused === u.routes, `fast: gas-only pass reuses every route (${info.reused} of ${u.routes}), only the stop amount is worked out again`);
  }

  // ---- 3. drift waits, real changes go at once, arbsim ends with the fresh table ----
  {
    const u = universe(6, 4), uRef = universe(6, 4);
    const c = { t: 1_000_000 }, cRef = { t: 1_000_000 };
    const env = { ...live }, envRef = { ...live, TRIG_TABLE_FAST: '0' };
    const N = entryWith(env, u.table(true, false), c);
    const R = entryWith(envRef, uRef.table(false, false), cRef);
    await pass(N, env); await pass(R, envRef);
    const sent0 = N.frames.length;
    // Gas moves (every row's stop amount changes): held back for 10 s.
    u.tick(0, { trades: false, reread: false, gas: true, px: false }); c.t += 1_000; await pass(N, env);
    assert(N.frames.length === sent0, `drift: a gas-only change is not sent at once (messages ${sent0} -> ${N.frames.length}; pools not rebuilt ${(N.te as any).tbl.lastSkipped}, rebuilt but held back ${(N.te as any).tbl.lastHeld})`);
    // A pool trades: its rows (and its partners') go at once.
    u.tick(1, { trades: true, reread: false, gas: false, px: false }); c.t += 1_000; await pass(N, env);
    const realSent = held(N.frames.slice(sent0));
    assert(N.frames.length > sent0 && realSent.size > 0 && realSent.size < u.pools, `real price change: sent at once (${realSent.size} of ${u.pools} pools)`);
    // After 10 s everything has gone, and arbsim holds exactly the fresh table.
    for (let r = 0; r < 11; r++) { c.t += 1_000; await pass(N, env); }
    for (const [r, o] of [[0, { trades: false, reread: false, gas: true, px: false }], [1, { trades: true, reread: false, gas: false, px: false }]] as const) uRef.tick(r, o);
    cRef.t = c.t; await pass(R, envRef);
    const a = held(N.frames), b = held(R.frames);
    assert(a.size === b.size && [...a].every(([k, v]) => b.get(k) === v), `after the drift wait arbsim holds exactly the fresh table (${a.size} pools, rows identical)`);
  }

  // ---- 4. pools whose facts did not move are not listed ----
  {
    const u = universe(10, 4);
    const c = { t: 1_000_000 };
    const env = { ...live };
    const N = entryWith(env, u.table(true, true), c);
    await pass(N, env);
    const l0 = u.listed();
    u.tick(0, { trades: false, reread: true, gas: true, px: true }); c.t += 1_000; await pass(N, env);
    const quiet = u.listed() - l0;
    u.tick(1, { trades: true, reread: false, gas: false, px: false }); c.t += 1_000; await pass(N, env);
    const busy = u.listed() - l0 - quiet;
    for (let r = 0; r < 11; r++) { c.t += 1_000; await pass(N, env); }
    const all = u.listed() - l0 - quiet - busy;
    assert(l0 === u.pools && quiet === 0, `quiet second (re-read, gas, WETH price only): no pool listed (${quiet} of ${u.pools})`);
    assert(busy > 0 && busy < u.pools, `a few pools traded: only those and their partners listed (${busy} of ${u.pools})`);
    assert(all >= u.pools, `every pool listed again within the drift time (${all} listings in 11 s)`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
