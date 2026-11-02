import { AbiCoder } from 'ethers';
import { practiceOnlyReason, resetV4EnvSnapshot, ALLOC_LEAN_V4, allocLeanOn, EXTRA_V4_TIERS, STANDARD_V4_TIERS } from '../config/v4Tiers';
import { enumerateRoutes, RouteRules, ALLOC_LEAN_ROUTES } from '../execution/trigEntry';
import { LiveCoinRule, liveCoinBlockerLean, liveCoinBlockerOld, ROBINHOOD_TOKEN_BEACON } from '../core/liveCoins';
import { GasCalibration, median } from '../core/gasModel';

// ============================================================================
// FIX 12 (Nov 2): less throwaway memory, SAME answers. Proves, old vs new:
//   1. practiceOnlyReason (lean path reads the bot's settings once) gives the
//      same answer for every kind of pool under every setting mix
//   2. enumerateRoutes (lean) lists the same routes, same order, same ids
//   3. the live coin rule (lean) gives the same answer AND starts the same
//      background coin look-ups in the same order
//   4. the gas median memo gives the same median, also after new samples
//   5. ALLOC_LEAN=0 / off switches all of it off
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Small repeatable random numbers (same every run).
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

function testPracticeOnly() {
  assert(ALLOC_LEAN_V4 && ALLOC_LEAN_ROUTES, 'lean on by default');
  assert(!allocLeanOn({ ALLOC_LEAN: '0' }) && !allocLeanOn({ ALLOC_LEAN: 'off' }) && allocLeanOn({}), 'ALLOC_LEAN=0 / off turns it off');
  const hooks = [undefined, '', '0x' + '0'.repeat(40), '0x' + '0'.repeat(39) + '1', '0X' + '0'.repeat(40)];
  const tiers: Array<[number, number]> = [...STANDARD_V4_TIERS, ...EXTRA_V4_TIERS, [750, 15], [1234, 7], [42, 42]];
  const pools: any[] = [{}, { v4: undefined }];
  for (const h of hooks) for (const [fee, tickSpacing] of tiers) pools.push({ v4: { fee, tickSpacing, hooks: h } });
  const keys = ['V4_EVENT_POOLS_LIVE', 'RH_V4_EXTRA_LIVE', 'RH_V4_MORE_TIERS', 'V4_TIERS_CACHE'];
  const saved = keys.map((k) => process.env[k]);
  let cases = 0, same = 0, practice = 0;
  for (const ev of [undefined, '0', 'off', '1'])
    for (const ex of [undefined, '0', 'off', '1'])
      for (const more of [undefined, '', '750:15', '750:15,1234:7', 'junk,42:42'])
        for (const cache of [undefined, '0']) {
          const set = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
          set('V4_EVENT_POOLS_LIVE', ev); set('RH_V4_EXTRA_LIVE', ex); set('RH_V4_MORE_TIERS', more); set('V4_TIERS_CACHE', cache);
          resetV4EnvSnapshot();
          const copy = { ...process.env }; // a copy = the old path (read every time)
          for (const p of pools) {
            const lean = practiceOnlyReason(p);
            const old = practiceOnlyReason(p, copy);
            cases++; if (lean === old) same++; if (old) practice++;
          }
        }
  keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  resetV4EnvSnapshot();
  assert(cases > 10_000 && same === cases && practice > 100, `practiceOnlyReason: ${same}/${cases} answers the same (${practice} practice-only cases among them)`);
}

function testRoutes() {
  type P = { addr: string; a: string; b: string; dex: string };
  const coins = ['0xUSDG000000000000000000000000000000000001', '0xWeth000000000000000000000000000000000002', '0xaaaa00000000000000000000000000000000000a', '0xBBBB00000000000000000000000000000000000B'];
  const caseMix = (x: string) => (rnd() < 0.5 ? x.toLowerCase() : rnd() < 0.5 ? x : x.toUpperCase().replace('0X', '0x'));
  let total = 0, runs = 0, same = 0;
  for (let run = 0; run < 300; run++) {
    const pools: P[] = [];
    const n = 2 + Math.floor(rnd() * 12);
    for (let i = 0; i < n; i++) {
      const a = pick(coins), b = pick(coins);
      pools.push({ addr: caseMix(`0x${(1000 + i).toString(16).padStart(40, 'c')}`), a: caseMix(a), b: caseMix(b), dex: pick(['uni', 'pancake', 'blocked']) });
    }
    // A duplicate address (different spelling) to hit the "same pool" skip.
    pools.push({ ...pools[0], addr: pools[0].addr.toUpperCase().replace('0X', '0x') });
    const byKey = new Map(pools.map((p) => [p.addr.toLowerCase(), p] as [string, P]));
    const rules: RouteRules<P> = {
      pool: (k) => byKey.get(k.toLowerCase()),
      peers: (p) => pools.filter((q) => q !== p && ((q.a.toLowerCase() === p.a.toLowerCase() && q.b.toLowerCase() === p.b.toLowerCase()) || (q.a.toLowerCase() === p.b.toLowerCase() && q.b.toLowerCase() === p.a.toLowerCase()))),
      addr: (p) => p.addr, tokens: (p) => [p.a, p.b],
      startCoins: [coins[0], coins[1]],
      coinAllowed: (t) => !t.toLowerCase().startsWith('0xbbbb') || rnd() < 2, // (always true, but reads the coin)
      venueBlocked: (buy, sell) => (buy.dex === 'blocked' || sell.dex === 'blocked' ? 'blocked' : null),
    };
    const keys = pools.map((p) => (rnd() < 0.5 ? p.addr : p.addr.toLowerCase())).concat(['0xmissing']);
    const old = enumerateRoutes(keys, rules, false);
    const lean = enumerateRoutes(keys, rules, true);
    const sig = (rs: typeof old) => rs.map((r) => `${r.id}|${pools.indexOf(r.buy)}|${pools.indexOf(r.sell)}|${r.tokenIn}|${r.tokenOut}`).join('\n');
    runs++; total += old.length;
    if (sig(old) === sig(lean)) same++;
  }
  assert(same === runs && total > 500, `enumerateRoutes: ${same}/${runs} random pool sets give the same routes, order and ids (${total} routes)`);
}

async function testCoins() {
  const coder = AbiCoder.defaultAbiCoder();
  const GOOD = '0x1111111111111111111111111111111111111111';
  const BAD = '0x2222222222222222222222222222222222222222';
  // A fake node: GOOD is an official Robinhood token, BAD is not, the rest never answer.
  const mk = (calls: string[]) => ({
    getStorage: (a: string) => { calls.push(a); if (a === GOOD) return Promise.resolve('0x' + '0'.repeat(24) + ROBINHOOD_TOKEN_BEACON.slice(2)); if (a === BAD) return Promise.resolve('0x' + '0'.repeat(64)); return new Promise<string>(() => undefined); },
    call: (tx: { to: string }) => Promise.resolve(coder.encode(['string'], [tx.to === GOOD ? 'Apple Robinhood Token' : 'Meme'])),
  });
  const base = ['0x3333333333333333333333333333333333333333']; // always allowed
  const toks = [GOOD, BAD, base[0], '0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555'];
  const variants = (t: string) => [t, t.toUpperCase().replace('0X', '0x')];
  for (const on of ['1', '0']) {
    const callsOld: string[] = [], callsLean: string[] = [];
    const ruleOld = new LiveCoinRule(mk(callsOld), base, { LIVE_COIN_RULE: on });
    const ruleLean = new LiveCoinRule(mk(callsLean), base, { LIVE_COIN_RULE: on });
    if (on === '1') {
      await Promise.all([ruleOld.lookup(GOOD), ruleOld.lookup(BAD), ruleLean.lookup(GOOD), ruleLean.lookup(BAD)]);
      callsOld.length = 0; callsLean.length = 0;
    }
    let n = 0, same = 0;
    for (let i = 0; i < 3_000; i++) {
      const side = () => (rnd() < 0.1 ? undefined : { chain: rnd() < 0.8 ? 'robinhood' : 'monad', tokenA: rnd() < 0.1 ? undefined : pick(variants(pick(toks))), tokenB: pick(variants(pick(toks))) });
      const buy = side(), sell = side();
      const a = liveCoinBlockerOld(ruleOld, buy, sell), b = liveCoinBlockerLean(ruleLean, buy, sell);
      n++; if (a === b) same++;
    }
    assert(same === n, `live coin rule ${on === '1' ? 'on' : 'off'}: ${same}/${n} answers the same`);
    assert(callsOld.join(',') === callsLean.join(','), `live coin rule ${on === '1' ? 'on' : 'off'}: same background look-ups in the same order (${callsOld.length})`);
  }
  assert(liveCoinBlockerLean(null, { chain: 'robinhood', tokenA: BAD }, undefined) === null, 'no rule yet: no blocker (as before)');
}

function testGasMedian() {
  const c = new GasCalibration(null, 50);
  let ok = true;
  for (let i = 0; i < 400; i++) {
    const key = pick(['2p:1-2:own', '2p:3-4:loan', 'loop:3']);
    c.add(key, 150_000 + Math.floor(rnd() * 400_000));
    for (const k of ['2p:1-2:own', '2p:3-4:loan', 'loop:3', '2p:any:own', '2p:any:loan', 'none']) {
      const want = median(c.snapshot()[k] ?? []);
      if (c.median(k) !== want || c.median(k) !== want) ok = false; // (twice: the remembered answer too)
    }
  }
  assert(ok, 'gas median memo: same median as working it out, after every new sample');
}

async function main() {
  testPracticeOnly();
  testRoutes();
  await testCoins();
  testGasMedian();
}
main().catch((e) => { console.error('FAIL:', e); process.exitCode = 1; });
