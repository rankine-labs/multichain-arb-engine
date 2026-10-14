// Tests for the loop fix phase 2 (owner approved, practice only):
//   A) confirmed view: loops priced from real (block / RPC) pool states
//   B) block states the main cache skipped are kept in the confirmed view
//   C) the trigger trade's hash reaches the loop practice check
//   D) model vs check numbers in the hourly loop report
//   E) cheap scan: unchanged scans skipped, sliced scan == one-go scan
//   and: every switch off == old behaviour.
import { PoolCache, confirmedViewFromEnv } from '../core/poolCache';
import { loopFixFromEnv, LoopTriggerBook, loopPoolState, triggerHashes } from '../core/loopPrices';
import { LoopFinder, LoopEnv, LoopResult } from '../core/loopFinder';
import { LoopTrader, loopConfigFromEnv, LoopTrade, LoopCheckContext, LoopCheckResult, summarizeLoopChecks, LoopCheckRecord } from '../core/loopTrader';
import { formatLoopHour, modelVsCheckText } from '../core/loopReport';
import { runSteps } from '../core/chunked';
import type { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1), USDG = A(2);
let clock = 5_000_000;
const E18 = 10n ** 18n;

function v2(addr: number, tA: string, tB: string, rA: number, rB: number, block = 1): PoolState {
  return { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
    reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n,
    feeBps: 30, lastUpdatedBlock: block, lastUpdatedMs: clock };
}

const env: LoopEnv = {
  decimalsOf: () => 18,
  usdOf: (t) => (t.toLowerCase() === W || t.toLowerCase() === USDG ? 1 : null),
  depthUsd: () => 1_000_000,
  gasUsd: (hops) => 0.01 * hops,
  isTradable: () => true,
  now: () => clock,
};
const tick = () => new Promise<void>((r) => setImmediate(r));

(async () => {
  // -------------------------------------------------------------------------
  // Switches: all off unless LOOP_TRADER=1; each can be turned off alone.
  // -------------------------------------------------------------------------
  {
    const off = loopFixFromEnv({});
    assert(!off.realPrices && !off.keepBlockUpdates && !off.triggerReplay && !off.modelVsCheck && !off.cheapScan, 'switches: all off when LOOP_TRADER is not set (default)');
    const on = loopFixFromEnv({ LOOP_TRADER: '1' });
    assert(on.realPrices && on.keepBlockUpdates && on.triggerReplay && on.modelVsCheck && on.cheapScan && on.sliceMs === 8, 'switches: all on with LOOP_TRADER=1, 8 ms slices');
    const one = loopFixFromEnv({ LOOP_TRADER: '1', LOOP_REAL_PRICES: '0', LOOP_SCAN_SLICE_MS: '4' });
    assert(!one.realPrices && one.keepBlockUpdates && one.sliceMs === 4, 'switches: LOOP_REAL_PRICES=0 turns only that one off');
    assert(!loopFixFromEnv({ LOOP_TRADER: '0' }).realPrices, 'switches: LOOP_TRADER=0 = all off');
    assert(!confirmedViewFromEnv({}) && confirmedViewFromEnv({ LOOP_TRADER: '1' }) && !confirmedViewFromEnv({ LOOP_TRADER: '1', LOOP_REAL_PRICES: '0' }), 'confirmed view only kept when loops + real prices are on');
    const plain = new PoolCache({ confirmed: false });
    plain.upsert(v2(10, W, A(50), 100, 100));
    plain.upsertFromBlock(v2(10, W, A(50), 101, 100, 2));
    assert(plain.confirmedCount() === 0 && plain.getConfirmed('robinhood', A(10)) === undefined && !plain.keepBlockState(v2(10, W, A(50), 1, 1, 3), 3), 'view off: nothing stored (no extra memory)');
  }

  // -------------------------------------------------------------------------
  // A) The confirmed view never takes feed writes.
  // -------------------------------------------------------------------------
  {
    const c = new PoolCache({ confirmed: true });
    const real = v2(20, W, A(60), 100, 200, 5);
    c.upsert(real);
    assert(c.getConfirmed('robinhood', A(20)) === real, 'RPC/discovery write goes into the confirmed view (same object, no copy)');
    const predicted = c.predictPostTradeState(real, true, 10n * E18);
    c.upsertFromFeed(predicted, clock);
    assert(c.get('robinhood', A(20))!.reserveA === predicted.reserveA, 'feed prediction is in the main cache (2-pool behaviour unchanged)');
    assert(c.getConfirmed('robinhood', A(20)) === real, 'feed prediction NOT in the confirmed view');
    c.upsertFromBlock(v2(20, W, A(60), 110, 182, 6), clock + 1);
    assert(c.getConfirmed('robinhood', A(20)) === c.get('robinhood', A(20)) && c.confirmedBlock('robinhood', A(20)) === 6, 'block write: main and confirmed share the same object, block 6');
    // RPC refresh that writes the main list also updates the confirmed view.
    const rpc = { ...v2(20, W, A(60), 120, 170, 7), lastUpdatedMs: clock + 10 };
    const wrote = c.upsertIfNotNewer(rpc, clock + 5, clock + 5_000);
    assert(wrote && c.getConfirmed('robinhood', A(20)) === rpc, 'RPC refresh written to main is also confirmed');
    // Pruning a pool removes its confirmed entry too (memory stays bounded).
    c.prune(() => false, 0, clock + 1e9);
    assert(c.size() === 0 && c.confirmedCount() === 0, 'prune removes confirmed entries with the pool');
    // Event fee seen later (kept on the main copy) is carried over.
    const c2 = new PoolCache({ confirmed: true });
    c2.upsertFromBlock(v2(21, W, A(61), 100, 100, 3));
    c2.upsertFromFeed(c2.predictPostTradeState(c2.get('robinhood', A(21))!, true, E18));
    c2.get('robinhood', A(21))!.observedFee = { z: { pips: 1234, block: 4, atMs: clock } };
    const cf = c2.getConfirmed('robinhood', A(21))!;
    assert(cf.observedFee?.z?.pips === 1234 && cf.reserveA === 100n * E18 && c2.getConfirmed('robinhood', A(21)) === cf, 'confirmed state carries the newer event fee (one merged copy, reused)');
  }

  // -------------------------------------------------------------------------
  // B) Block update kept in the confirmed view when the main write is
  //    skipped; an older block never overwrites a newer one.
  // -------------------------------------------------------------------------
  {
    const c = new PoolCache({ confirmed: true });
    c.upsertFromBlock(v2(30, W, A(70), 100, 100, 10));
    const pred = c.predictPostTradeState(c.get('robinhood', A(30))!, true, 5n * E18);
    c.upsertFromFeed(pred);
    const mainBefore = c.get('robinhood', A(30));
    // The block reader skips the main write (feed wrote moments ago) but keeps it here.
    const kept = c.keepBlockState(v2(30, W, A(70), 105, 95.3, 11), 11);
    assert(kept && c.confirmedBlock('robinhood', A(30)) === 11 && c.getConfirmed('robinhood', A(30))!.reserveA === 105n * E18, 'skipped block state kept in the confirmed view (block 11)');
    assert(c.get('robinhood', A(30)) === mainBefore && c.fedWithin('robinhood', A(30), 400), 'main cache untouched by keepBlockState (still the feed prediction)');
    const older = c.keepBlockState(v2(30, W, A(70), 1, 1, 9), 9);
    assert(!older && c.confirmedBlock('robinhood', A(30)) === 11 && c.getConfirmed('robinhood', A(30))!.reserveA === 105n * E18, 'older block (9) never overwrites the newer confirmed one (11)');
    // A main block write with an older block than the kept one: main written, confirmed keeps block 11.
    c.upsertFromBlock(v2(30, W, A(70), 50, 50, 10));
    assert(c.confirmedBlock('robinhood', A(30)) === 11, 'main block write of an older block does not roll the confirmed view back');
    // An RPC read that started before the kept block state can't overwrite it in the confirmed view.
    c.keepBlockState(v2(30, W, A(70), 106, 94, 12), 12, clock + 100);
    for (let i = 0; i < 3; i++) c.upsertIfNotNewer({ ...v2(30, W, A(70), 1, 1, 0), lastUpdatedMs: clock + 50 }, clock + 50, clock + 5_000);
    assert(c.getConfirmed('robinhood', A(30))!.reserveA === 106n * E18, 'RPC read older than the kept block state does not replace it');
    assert(!c.keepBlockState(v2(31, W, A(71), 1, 1, 1), 1) && c.confirmedCount() === 1, 'pools the cache does not know are never added (bounded)');
  }

  // -------------------------------------------------------------------------
  // A) Loop pricing: trigger pool = one prediction on the confirmed state,
  //    every other pool = confirmed state; switch off = main cache.
  // -------------------------------------------------------------------------
  {
    const c = new PoolCache({ confirmed: true });
    const p1 = v2(40, W, A(80), 100, 100, 3), p2 = v2(41, A(80), A(81), 100, 100, 3);
    c.upsertFromBlock(p1); c.upsertFromBlock(p2);
    // Two earlier feed predictions stacked on pool 40 in the main cache, and one on pool 41.
    for (let i = 0; i < 2; i++) c.upsertFromFeed(c.predictPostTradeState(c.get('robinhood', A(40))!, true, E18));
    c.upsertFromFeed(c.predictPostTradeState(c.get('robinhood', A(41))!, true, E18));
    const book = new LoopTriggerBook();
    book.note(A(40), { hash: '0xtrig', inIsA: true, amountIn: E18, at: clock });
    const trig = book.take();
    assert(book.size() === 0 && trig.size === 1, 'trigger book hands over and empties');
    const predict = (p: PoolState, i: boolean, a: bigint) => c.predictPostTradeState(p, i, a);
    const s40 = loopPoolState(c.get('robinhood', A(40)), c.getConfirmed('robinhood', A(40)), trig.get(A(40)), true, predict, clock);
    const s41 = loopPoolState(c.get('robinhood', A(41)), c.getConfirmed('robinhood', A(41)), trig.get(A(41)), true, predict, clock);
    const want40 = c.predictPostTradeState(c.getConfirmed('robinhood', A(40))!, true, E18);
    assert(!!s40 && s40.reserveA === want40.reserveA && s40.reserveB === want40.reserveB && s40.reserveA !== c.get('robinhood', A(40))!.reserveA, 'trigger pool: ONE prediction on top of the confirmed state (not the stacked main copy)');
    assert(s41 === c.getConfirmed('robinhood', A(41)), 'other pools: the confirmed state as is');
    const off40 = loopPoolState(c.get('robinhood', A(40)), c.getConfirmed('robinhood', A(40)), trig.get(A(40)), false, predict, clock);
    assert(off40 === c.get('robinhood', A(40)), 'LOOP_REAL_PRICES off: main cache state (old behaviour)');
    assert(loopPoolState(undefined, undefined, undefined, true, predict, clock) === undefined, 'no confirmed state, no trigger: pool left out');
    const h = triggerHashes(trig);
    assert(h.get(A(40))?.hash === '0xtrig', 'trigger hashes by pool');
  }

  // -------------------------------------------------------------------------
  // C) The trigger hash reaches the loop check. D) model vs check record.
  // -------------------------------------------------------------------------
  function trader(fix: Record<string, boolean> | undefined, calls: { trade: LoopTrade; ctx?: LoopCheckContext; args: number }[], result: LoopCheckResult, gasNotes: number[] = []) {
    const cfg = loopConfigFromEnv({ LOOP_TRADER: '1' });
    return new LoopTrader(cfg, {
      env, bases: [W], symbolOf: (t) => (t === W ? 'WETH' : 'T' + parseInt(t.slice(-4), 16)), decimalsOf: () => 18,
      canPracticeTest: () => true, canCheckNow: () => true,
      runCheck: async (...a: [LoopTrade, LoopCheckContext?]) => { calls.push({ trade: a[0], ctx: a[1], args: a.length }); return result; },
      ...(fix ? { fix, noteGas: (_n: number, g: bigint) => { gasNotes.push(Number(g)); } } : {}),
    });
  }
  const loopPools = (base: number) => [v2(base, W, A(base + 100), 1_000, 2_000), v2(base + 1, A(base + 100), A(base + 101), 2_000, 2_000), v2(base + 2, A(base + 101), W, 1_000, 1_300)];
  {
    const calls: { trade: LoopTrade; ctx?: LoopCheckContext; args: number }[] = [];
    const gasNotes: number[] = [];
    const t = trader({ triggerReplay: true, modelVsCheck: true }, calls, { status: 'profit', profit: E18 / 10n, gasUsed: 500_000n, timing: 'right after trigger' }, gasNotes);
    clock += 10_000;
    const pools = loopPools(200);
    t.onUpdate(pools, { triggers: new Map([[A(201).toLowerCase(), { hash: '0xabc', at: clock }]]) });
    await tick();
    assert(calls.length === 1 && calls[0].ctx?.triggerHash === '0xabc', 'trigger hash reaches the loop practice check');
    const hr = t.takeHour();
    const rec = hr.checkVsEstimate;
    assert(gasNotes.length === 1 && gasNotes[0] === 500_000, 'real gas from the check is passed to the gas model');
    const row = rec.modelVsCheck?.[0];
    assert(!!row && row.timing === 'right after trigger' && row.n === 1 && Math.abs(row.checkUsd - 0.1) < 1e-9 && row.modelUsd > 0, 'model vs check recorded by timing (check $0.10 profit before gas)');
    const txt = formatLoopHour(hr, 5);
    assert(txt.includes('model vs check (profit before gas, by timing): right after trigger 1: model said $') && txt.includes('check said $0.10, gap'), 'hourly loop report shows the model vs check line');

    // No trigger (safety net / block update): no hash, checked on latest.
    const calls2: { trade: LoopTrade; ctx?: LoopCheckContext; args: number }[] = [];
    const t2 = trader({ triggerReplay: true, modelVsCheck: true }, calls2, { status: 'loss', timing: 'latest' });
    clock += 10_000;
    t2.onUpdate(loopPools(300));
    await tick();
    assert(calls2.length === 1 && calls2[0].ctx === undefined, 'no trigger: check gets no hash (latest, as before)');
    const r2 = t2.takeHour().checkVsEstimate.modelVsCheck?.[0];
    assert(!!r2 && r2.timing === 'latest' && r2.losses === 1 && r2.checkUsd === 0, 'loss counted as $0 check result (loss size unknown)');
    // Trigger on a pool NOT in the loop: no hash.
    const calls3: { trade: LoopTrade; ctx?: LoopCheckContext; args: number }[] = [];
    const t3 = trader({ triggerReplay: true }, calls3, { status: 'loss' });
    clock += 10_000;
    t3.onUpdate(loopPools(400), { triggers: new Map([[A(999), { hash: '0xother', at: clock }]]) });
    await tick();
    assert(calls3.length === 1 && calls3[0].ctx === undefined, 'trigger on an unrelated pool: no hash');

    // Switches off: runCheck called exactly as before (one argument), no extra record fields.
    const calls4: { trade: LoopTrade; ctx?: LoopCheckContext; args: number }[] = [];
    const t4 = trader(undefined, calls4, { status: 'profit', profit: E18 / 10n });
    clock += 10_000;
    t4.onUpdate(loopPools(500), { triggers: new Map([[A(501).toLowerCase(), { hash: '0xabc', at: clock }]]) });
    await tick();
    const h4 = t4.takeHour();
    assert(calls4.length === 1 && calls4[0].args === 1, 'switches off: check called with the trade only (old behaviour)');
    assert(h4.checkVsEstimate.modelVsCheck === undefined && !formatLoopHour(h4, 5).includes('model vs check'), 'switches off: no model vs check line');
  }
  {
    // Summary maths and text.
    const recs: LoopCheckRecord[] = [
      { route: 'a', estUsd: 1, outcome: 'profit', resultUsd: 0.2, delayMs: 100, timing: 'right after trigger', modelGrossUsd: 1, checkGrossUsd: 0.3 },
      { route: 'a', estUsd: 1, outcome: 'loss', resultUsd: -0.07, delayMs: 100, timing: 'right after trigger', modelGrossUsd: 1, checkGrossUsd: 0 },
      { route: 'b', estUsd: 1, outcome: 'fail', resultUsd: null, delayMs: 100, timing: 'latest', modelGrossUsd: 1, checkGrossUsd: null },
    ];
    const txt = modelVsCheckText(summarizeLoopChecks(recs));
    assert(txt === 'model vs check (profit before gas, by timing): right after trigger 2: model said $2.00, check said $0.30, gap 85% (1 lost, loss size unknown so counted as $0)', `model vs check text (${txt})`);
  }

  // -------------------------------------------------------------------------
  // E) Sliced scan gives exactly the same answer as a one-go scan.
  // -------------------------------------------------------------------------
  {
    const toks = Array.from({ length: 50 }, (_, i) => (i === 0 ? W : i === 1 ? USDG : A(3000 + i)));
    let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pools: PoolState[] = [];
    for (let i = 2; i < 50; i++) { pools.push(v2(6000 + i * 2, W, toks[i], 1_000 * (1 + rnd()), 1_000 * (1 + rnd()))); pools.push(v2(6001 + i * 2, USDG, toks[i], 1_000 * (1 + rnd()), 1_000 * (1 + rnd()))); }
    for (let i = 0; i < 200; i++) { const a = 2 + Math.floor(rnd() * 48), b = 2 + Math.floor(rnd() * 48); if (a !== b) pools.push(v2(8000 + i, toks[a], toks[b], 1_000 * (1 + rnd()), 1_000 * (1 + rnd()))); }
    pools.push(v2(8999, W, USDG, 1_000, 1_000));
    clock += 120_000;
    // No time budget, so the answer can't depend on timing at all.
    const cfg = { bases: [W, USDG], updateBudgetMs: Infinity, exactTopK: 1_000 };
    const one = new LoopFinder(cfg, env), sl = new LoopFinder(cfg, env);
    one.update(pools); await one.idle();
    await runSteps(sl.updateSteps(pools), 'loop scan', 0.01); await sl.idle();
    const sig = (rs: LoopResult[]) => rs.map((r) => `${r.cycle.sig}|${r.amountIn}|${r.amountOut}|${r.netUsd.toFixed(9)}`).join('\n');
    let same = true, total = 0, slices = 0;
    for (let k = 0; k < 8; k++) {
      clock += 300;
      for (let j = 0; j < 12; j++) { const i = Math.floor(rnd() * pools.length); pools[i] = { ...pools[i], reserveA: pools[i].reserveA! + 10n ** 16n * BigInt(1 + j * 7), lastUpdatedMs: clock }; }
      const a = one.update(pools);
      // Count how many slices the sliced run takes (tiny 0.01 ms slices).
      const gen = sl.updateSteps(pools);
      let r = gen.next(); slices++;
      while (!r.done) { await tick(); r = gen.next(); slices++; }
      const b = r.value;
      total += a.results.length;
      if (sig(a.results) !== sig(b.results) || a.evaluated.join(',') !== b.evaluated.join(',') || a.changedPools !== b.changedPools || a.rebuilt !== b.rebuilt) same = false;
    }
    assert(same && total > 0, `sliced scan == one-go scan (${total} paying loops over 8 updates, ${slices} slices)`);
    assert(slices > 16, 'the sliced scan really stops part way (more than 2 slices per update)');

    // Whole loop trader: steps run in slices vs onUpdate in one go -> same counts.
    const mk = (cheap: boolean) => new LoopTrader(loopConfigFromEnv({ LOOP_TRADER: '1', LOOP_CHECKS_PER_MIN: '0' }), {
      env, bases: [W, USDG], symbolOf: () => 'T', decimalsOf: () => 18, canPracticeTest: () => true, canCheckNow: () => true,
      runCheck: async () => ({ status: 'loss' }), fix: { cheapScan: cheap },
    });
    const tA = mk(false), tB = mk(true);
    // No time budget here either (the answer must not depend on timing).
    for (const t of [tA, tB]) (t.finder.cfg as { updateBudgetMs: number }).updateBudgetMs = Infinity;
    clock += 120_000;
    const ps = pools.map((p) => ({ ...p, lastUpdatedMs: clock })); // fresh prices (30 s age limit)
    tA.onUpdate(ps); await runSteps(tB.onUpdateSteps(ps), 'loop scan', 0.01);
    await tA.finder.idle(); await tB.finder.idle();
    for (let k = 0; k < 6; k++) {
      clock += 300;
      if (k % 2 === 0) { const i = Math.floor(rnd() * ps.length); ps[i] = { ...ps[i], reserveB: ps[i].reserveB! + 10n ** 17n, lastUpdatedMs: clock }; }
      tA.onUpdate(ps);
      await runSteps(tB.onUpdateSteps(ps), 'loop scan', 0.01);
    }
    const hA = tA.takeHour(), hB = tB.takeHour();
    assert(hA.found > 0 && hA.found === hB.found && hA.bestUsd === hB.bestUsd && hA.cycles === hB.cycles, `loop trader: sliced + cheap scan finds the same loops (found ${hA.found} vs ${hB.found})`);
    assert((hB.skippedScans ?? 0) >= 1 && hA.skippedScans === undefined, `cheap scan skipped unchanged scans (${hB.skippedScans ?? 0}), off = never skipped`);
  }

  // -------------------------------------------------------------------------
  // E) Skip only when nothing changed.
  // -------------------------------------------------------------------------
  {
    const calls: { trade: LoopTrade; ctx?: LoopCheckContext; args: number }[] = [];
    const t = trader({ cheapScan: true }, calls, { status: 'loss' });
    clock += 120_000;
    const ps = loopPools(700);
    t.onUpdate(ps);         // first: priced
    t.onUpdate(ps);         // same states, nothing waiting: skipped
    const changed = [ps[0], { ...ps[1], reserveA: ps[1].reserveA! + 1n }, ps[2]];
    t.onUpdate(changed);    // a pool changed: runs
    t.onUpdate(changed.slice(0, 2)); // a pool left: runs
    const h = t.takeHour();
    assert(h.skippedScans === 1 && h.updates === 3, `cheap scan: skipped only the unchanged scan (skipped ${h.skippedScans}, ran ${h.updates})`);
  }
})();
