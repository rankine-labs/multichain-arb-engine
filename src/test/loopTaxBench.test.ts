// Tests for the coin tax test and route memory (core/coinTax.ts,
// core/loopTrader.ts, Oct 20). The Oct 20 finding: the coin the bot called
// "MCD" (Meridian Capital) took 3.0% on every move, so loops through it
// always looked profitable and always lost.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { testCoinTax, CoinTaxBook, coinTaxConfigFromEnv, lostMoreThanTolerance, coinHolderOf, CoinTaxGate, TaxVerdict, CoinTaxStats } from '../core/coinTax';
import { LoopTrader, loopConfigFromEnv, LoopTrade } from '../core/loopTrader';
import { loopLogLine, formatLoopHour } from '../core/loopReport';
import type { LoopEnv } from '../core/loopFinder';
import type { PoolState } from '../core/types';
import type { SimResult, Rpc } from '../execution/simulator';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1);
const TOKEN = A(0xabc), POOL = A(0xdef);
const hex = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

// A fake node: the pool holds `bal`; a move keeps (100 - taxPct)% of what is sent.
// outOk / backOk = whether the two moves go through; simErr = no simulation support.
function fakeNode(o: { bal: bigint; taxPct?: number; outOk?: boolean; backOk?: boolean; simErr?: boolean }): { rpc: Rpc; calls: string[] } {
  const calls: string[] = [];
  const rpc: Rpc = async (method, params: any[]) => {
    calls.push(method);
    if (method === 'eth_call') return { result: hex(o.bal) };
    if (method === 'eth_simulateV1') {
      if (o.simErr) return { error: { code: -32601, message: 'method not found' } };
      const cs = params[0].blockStateCalls[0].calls;
      const amt = BigInt('0x' + cs[1].data.slice(74));
      const back = BigInt('0x' + cs[4].data.slice(74));
      const keep = (x: bigint) => (x * BigInt(Math.round((100 - (o.taxPct ?? 0)) * 100))) / 10_000n;
      const got = keep(amt);
      const ok = (b: boolean | undefined) => (b === false ? '0x0' : '0x1');
      return { result: [{ calls: [
        { status: '0x1', returnData: hex(0n) },
        { status: ok(o.outOk), returnData: '0x' },
        { status: '0x1', returnData: hex(o.outOk === false ? 0n : got) },
        { status: '0x1', returnData: hex(o.bal - amt) },
        { status: ok(o.backOk), returnData: '0x' },
        { status: '0x1', returnData: hex(o.bal - amt + (o.backOk === false ? 0n : keep(back))) },
      ] }] };
    }
    return { error: { message: 'unexpected' } };
  };
  return { rpc, calls };
}

(async () => {
  // ---- 1) The test itself ----
  {
    const clean = await testCoinTax(fakeNode({ bal: 10n ** 24n }).rpc, TOKEN, POOL);
    assert(clean.verdict === 'ok', 'coin that arrives in full: ok');
    const mcd = await testCoinTax(fakeNode({ bal: 1_191_585n * 10n ** 18n, taxPct: 3 }).rpc, TOKEN, POOL);
    assert(mcd.verdict === 'taxed' && Math.abs((mcd.lossPct ?? 0) - 3) < 0.02, `MCD case (3% taken on each move): taxed, ${mcd.lossPct}%`);
    const tiny = await testCoinTax(fakeNode({ bal: 10n ** 24n, taxPct: 0.01 }).rpc, TOKEN, POOL);
    assert(tiny.verdict === 'ok', '0.01% loss is under the 0.05% tolerance: ok');
    const half = await testCoinTax(fakeNode({ bal: 10n ** 24n, taxPct: 0.1 }).rpc, TOKEN, POOL);
    assert(half.verdict === 'taxed', '0.1% taken: taxed');
    const refused = await testCoinTax(fakeNode({ bal: 10n ** 24n, outOk: false }).rpc, TOKEN, POOL);
    assert(refused.verdict === 'blocked', 'move out of the pool refused: blocked');
    const noBack = await testCoinTax(fakeNode({ bal: 10n ** 24n, backOk: false }).rpc, TOKEN, POOL);
    assert(noBack.verdict === 'blocked', 'move back into the pool refused: blocked');
    const huge = await testCoinTax(fakeNode({ bal: 10n ** 24n, taxPct: 20, backOk: false }).rpc, TOKEN, POOL);
    assert(huge.verdict === 'taxed', '20% tax (move back of 90% fails): taxed');
    const noSim = await testCoinTax(fakeNode({ bal: 10n ** 24n, simErr: true }).rpc, TOKEN, POOL);
    assert(noSim.verdict === null, 'node without simulation support: unclear (nothing recorded)');
    const empty = fakeNode({ bal: 0n });
    const e = await testCoinTax(empty.rpc, TOKEN, POOL);
    assert(e.verdict === null && empty.calls.length === 1, 'pool holds none of the coin: unclear, no simulation sent');
    const two = fakeNode({ bal: 10n ** 24n });
    await testCoinTax(two.rpc, TOKEN, POOL);
    assert(two.calls.join(',') === 'eth_call,eth_simulateV1', 'one test = 2 node requests (balance read + one simulation), nothing sent');
    assert(lostMoreThanTolerance(10_000n, 9_994n) && !lostMoreThanTolerance(10_000n, 9_995n), 'tolerance is 0.05%');
    assert(coinHolderOf({ poolAddress: POOL }) === POOL && coinHolderOf({ poolAddress: '0x' + 'ab'.repeat(32), v4: { poolManager: A(9) } }) === A(9)
      && coinHolderOf({ poolAddress: '0x' + 'ab'.repeat(32) }) === null, 'coins are held by the pool, or the V4 PoolManager for V4 pools');
  }

  // ---- 2) The book: limits, expiry, saved file ----
  {
    let now = 1_000_000;
    const tested: string[] = [];
    const cfg = { ...coinTaxConfigFromEnv({}), perMin: 2 };
    const verdicts: Record<string, TaxVerdict | null> = { [A(10)]: 'ok', [A(11)]: 'taxed', [A(12)]: null };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-'));
    const file = path.join(dir, 'coin-tax.json');
    const logs: string[] = [];
    const book = new CoinTaxBook(cfg, async (t) => { tested.push(t); return { verdict: t in verdicts ? verdicts[t] : 'ok', lossPct: verdicts[t] === 'taxed' ? 3 : undefined }; },
      { now: () => now, file, log: (m) => logs.push(m), symbolOf: (t) => (t === A(11) ? 'MCD' : 'X'), alwaysOk: [W] });
    assert(book.verdict(W) === 'ok' && book.verdict(A(10)) === undefined, 'base coin always ok; new coin untested');
    book.request(A(10), POOL); book.request(A(10), POOL); book.request(A(11), POOL); book.request(A(12), POOL);
    assert(book.stats().waiting === 3, 'same coin asked twice: queued once');
    await book.runNext(); await book.runNext();
    assert(!(await book.runNext()) && tested.length === 2, 'LOOP_TAX_TESTS_PER_MIN=2: third test waits for the next minute');
    assert(book.verdict(A(10)) === 'ok' && book.verdict(A(11)) === 'taxed', 'results recorded');
    assert(logs.some((l) => l.includes('MCD') && l.includes('takes a cut') && l.includes('3%')), 'taxed coin logged once with its cut');
    now += 61_000;
    await book.runNext();
    assert(book.verdict(A(12)) === undefined && book.stats().unclear === 1, 'unclear answer: nothing recorded');
    assert(logs.some((l) => l.includes("couldn't tell")) && book.stats().topUnclear?.[1] === 1, 'unclear answer logged, reason counted for the hour line');
    book.request(A(12), POOL);
    assert(book.stats().waiting === 0, 'unclear coin not asked again for 10 minutes');
    now += 11 * 60_000;
    book.request(A(12), POOL);
    assert(book.stats().waiting === 1, 'after 10 minutes it is tried again');
    book.save(true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(saved.coins[A(10)]?.v === 'ok' && saved.coins[A(11)]?.v === 'taxed' && !saved.coins[W], 'saved to the file (base coins not written)');
    const again = new CoinTaxBook(cfg, async () => ({ verdict: 'ok' }), { now: () => now, file });
    assert(again.verdict(A(11)) === 'taxed' && again.verdict(A(10)) === 'ok', 'restart: results read back from the file');
    now += 7 * 3600_000;
    assert(again.verdict(A(10)) === undefined && again.verdict(A(11)) === 'taxed', 'after 6 h a passed coin is tested again; a taxed coin stays out until its re-test');
    again.request(A(11), POOL);
    assert(again.stats().waiting === 0, 'taxed coin not re-tested before 24 h');
    now += 18 * 3600_000;
    again.request(A(11), POOL);
    assert(again.stats().waiting === 1, 'taxed coin re-tested after 24 h');
    assert(!coinTaxConfigFromEnv({ LOOP_TAX_TEST: '0' }).enabled && coinTaxConfigFromEnv({}).enabled && coinTaxConfigFromEnv({}).perMin === 10, 'LOOP_TAX_TEST=0 turns it off; on by default, 10 tests a minute');
    // A busy node: tried again after 1 minute (not 10).
    let t2 = 0;
    const busyBook = new CoinTaxBook(cfg, async () => ({ verdict: null, why: 'skipped: node busy' }), { now: () => t2 });
    busyBook.request(A(20), POOL); await busyBook.runNext();
    t2 += 30_000; busyBook.request(A(20), POOL);
    const early = busyBook.stats().waiting;
    t2 += 31_000; busyBook.request(A(20), POOL);
    assert(early === 0 && busyBook.stats().waiting === 1, 'node busy: tried again after 1 minute');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 3) The loop trader with the tax gate and route memory ----
  let clock = 5_000_000;
  const env: LoopEnv = {
    decimalsOf: () => 18,
    usdOf: (t) => (t.toLowerCase() === W ? 1 : null),
    depthUsd: () => 1_000_000,
    gasUsd: (hops) => 0.01 * hops,
    isTradable: () => true,
    now: () => clock,
  };
  const v2 = (addr: number, tA: string, tB: string, rA: number, rB: number): PoolState => ({
    chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
    reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n,
    feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: clock,
  });
  const tick = () => new Promise<void>((r) => setImmediate(r));
  // A fake tax gate the test controls.
  class FakeGate implements CoinTaxGate {
    v = new Map<string, TaxVerdict>();
    asked: [string, string][] = [];
    runs = 0;
    pending: string[] = [];
    verdict(t: string) { return t.toLowerCase() === W ? 'ok' : this.v.get(t.toLowerCase()); }
    request(t: string, holder: string) { this.asked.push([t, holder]); if (!this.pending.includes(t)) this.pending.push(t); }
    hasWork() { return this.pending.length > 0; }
    async runNext() { const t = this.pending.shift(); if (!t) return false; this.runs++; this.v.set(t, this.result(t)); return true; }
    result: (t: string) => TaxVerdict = () => 'ok';
    stats(): CoinTaxStats { return { tested: this.v.size, ok: 0, taxed: [...this.v.values()].filter((x) => x === 'taxed').length, blocked: 0, waiting: this.pending.length, unclear: 0, taxedNames: [] }; }
  }
  const mk = (over: Record<string, string>, checks: LoopTrade[], gate: CoinTaxGate | undefined, result: () => SimResult) => {
    const cfg = loopConfigFromEnv({ LOOP_TRADER: '1', ...over });
    const trader = new LoopTrader(cfg, {
      env, bases: [W], symbolOf: (t) => (t === W ? 'WETH' : 'T' + parseInt(t.slice(-4), 16)), decimalsOf: () => 18,
      canPracticeTest: () => true, canCheckNow: () => true,
      runCheck: async (t) => { checks.push(t); return result(); },
      ...(gate ? { coinTax: gate } : {}),
    });
    // BUSY-MACHINE FIX (Nov 1): these checks are about the tax gate and route
    // memory, not speed. The loop finder builds its loop list in 5 ms slices
    // and prices loops within a 12 ms budget (real clock). A 3-pool map
    // normally fits in the first slice, so the loop shows up on the very
    // first update. On the busy live server (CPU 93%) the process can be
    // paused for more than 5 ms mid-build: the list then finishes in the
    // background, the first update sees no loop, and "hour line: 1 loop
    // waiting for a coin test" failed 3 deploys in a row. Giving this test's
    // finder a 60 s slice and budget makes the outcome the same on any
    // machine; the slicing itself is tested in loopFinder's own tests.
    trader.finder.cfg.sliceMs = 60_000;
    trader.finder.cfg.updateBudgetMs = 60_000;
    return trader;
  };
  const loop = (base: number, t1: number, t2: number) => [v2(base, W, A(t1), 1_000, 2_000), v2(base + 1, A(t1), A(t2), 2_000, 2_000), v2(base + 2, A(t2), W, 1_000, 1_300)];

  {
    // Untested coins: the loop is not checked; both coins are queued for a test
    // (holder = the pool the coin comes out of). After they pass, it is checked.
    const checks: LoopTrade[] = [];
    const gate = new FakeGate();
    const t = mk({}, checks, gate, () => ({ status: 'profit', profit: 5n * 10n ** 17n }));
    const pools = loop(21, 100, 101);
    t.onUpdate(pools);
    await tick(); await tick();
    assert(checks.length === 0, 'loop with untested coins: not checked yet');
    assert(gate.asked.some(([c, h]) => c === A(100) && h === A(21)) && gate.asked.some(([c, h]) => c === A(101) && h === A(22)), 'both coins queued for a test, held by the pool they come out of');
    assert(gate.runs === 2, `the coin tests ran (on the loop node, one at a time): ${gate.runs}`);
    let h = t.takeHour();
    assert(h.coins?.waitTest === 1, 'hour line: 1 loop waiting for a coin test');
    // Loop closes and reopens: now both coins passed -> checked.
    clock += 1; t.onUpdate([pools[0], pools[1], v2(23, A(101), W, 1_000, 500)]);
    clock += 1; t.onUpdate(pools.map((p) => ({ ...p, lastUpdatedMs: clock })));
    await tick(); await tick();
    assert(checks.length === 1, 'coins passed: loop checked');
    h = t.takeHour();
    assert(h.wouldMake === 1, 'and the real profit counted');
  }
  {
    // Coins are tested ahead of time: pools with no paying loop still get their coins queued.
    const gate = new FakeGate();
    const t = mk({}, [], gate, () => ({ status: 'loss' }));
    clock += 120_000;
    t.onUpdate([v2(91, W, A(500), 1_000, 1_000), v2(92, A(500), A(501), 1_000, 1_000)]);
    assert(gate.asked.some(([c]) => c === A(500)) && gate.asked.some(([c]) => c === A(501)) && !gate.asked.some(([c]) => c === W), 'coins on loop pools tested ahead of time (base coins never)');
  }
  {
    // A taxed coin: its pools are left out, so the loop is never even found.
    const checks: LoopTrade[] = [];
    const gate = new FakeGate();
    gate.v.set(A(201), 'taxed');
    const t = mk({}, checks, gate, () => ({ status: 'profit', profit: 5n * 10n ** 17n }));
    clock += 120_000;
    t.onUpdate(loop(41, 200, 201));
    await tick(); await tick();
    const h = t.takeHour();
    assert(h.found === 0 && checks.length === 0 && t.finder.cycleCount() === 0, 'taxed coin: its pools are left out, no loop built, no check');
    assert(h.coins?.taxPools === 2, `hour line: 2 pools left out (${h.coins?.taxPools})`);
    const line = loopLogLine(h, 5, 'hour');
    assert(line.includes('pools left out 2') && line.includes('(taxed 1,'), `log line shows it: ${line.slice(line.indexOf('coins'))}`);
    assert(formatLoopHour(h, 5).includes('pools left out 2'), 'Telegram block shows it');
  }
  {
    // Route memory: 5 losing checks in a row -> benched 20 min, then checked again.
    const checks: LoopTrade[] = [];
    const t = mk({ LOOP_CHECKS_PER_MIN: '60' }, checks, undefined, () => ({ status: 'loss' }));
    clock += 120_000;
    const pools = loop(61, 300, 301);
    const reopen = async () => {
      clock += 1; t.onUpdate([pools[0], pools[1], v2(63, A(301), W, 1_000, 500)]);
      clock += 1; t.onUpdate(pools.map((p) => ({ ...p, lastUpdatedMs: clock })));
      await tick(); await tick();
    };
    t.onUpdate(pools); await tick(); await tick();
    for (let i = 0; i < 4; i++) await reopen();
    assert(checks.length === 5, `5 losing checks (${checks.length})`);
    await reopen(); await reopen();
    assert(checks.length === 5, 'benched after 5 losses in a row: not checked again');
    const h = t.takeHour();
    assert(h.coins?.benchStarts === 1 && h.coins.benchedNow === 1 && h.coins.benchedSkips === 2, 'hour line: 1 route benched, 2 skipped');
    clock += 21 * 60_000;
    // The loop list is rebuilt (in slices) after a long quiet spell: let it finish.
    t.onUpdate(pools.map((p) => ({ ...p, lastUpdatedMs: clock }))); await t.finder.idle();
    await reopen();
    assert(checks.length === 6, 'after 20 minutes it is checked again');
  }
  {
    // A win clears the count (a real route that sometimes loses is not benched).
    const checks: LoopTrade[] = [];
    let n = 0;
    const t = mk({ LOOP_CHECKS_PER_MIN: '60' }, checks, undefined, () => (++n % 4 === 0 ? { status: 'profit', profit: 5n * 10n ** 17n } : { status: 'loss' }));
    clock += 120_000;
    const pools = loop(81, 400, 401);
    t.onUpdate(pools); await tick(); await tick();
    for (let i = 0; i < 11; i++) {
      clock += 1; t.onUpdate([pools[0], pools[1], v2(83, A(401), W, 1_000, 500)]);
      clock += 1; t.onUpdate(pools.map((p) => ({ ...p, lastUpdatedMs: clock })));
      await tick(); await tick();
    }
    assert(checks.length === 12 && t.takeHour().coins?.benchStarts === 0, 'win every 4th check: never benched (12 checks)');
    assert(loopConfigFromEnv({ LOOP_BENCH_AFTER: '0' }).benchAfter === 0 && loopConfigFromEnv({}).benchAfter === 5 && loopConfigFromEnv({}).benchMs === 20 * 60_000, 'LOOP_BENCH_AFTER=0 turns it off; defaults 5 in a row, 20 min');
  }
  {
    // Both off: the hour has no "coins" part and the log line is unchanged.
    const t = mk({ LOOP_BENCH_AFTER: '0' }, [], undefined, () => ({ status: 'loss' }));
    assert(t.takeHour().coins === undefined, 'tax test and route memory off: report exactly as before');
  }
})();
