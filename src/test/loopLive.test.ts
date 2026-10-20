// Tests for LIVE LOOPS (execution/loopLive.ts and the hand-over in
// core/loopTrader.ts, Oct 20). Every real send must pass: limits, live
// clearance, funding (wallet first, then flash loan), the real check
// (check first), the outlier guard and the safety gate. The loop loss cap
// pauses live loops for the day.
import { LoopLiveSender, loopLiveConfigFromEnv, LoopLiveCandidate, LoopLiveDeps, LoopFunding } from '../execution/loopLive';
import { EXECUTE_SELECTOR, EXECUTE_V3_FLASH_SELECTOR, decodeExecuteCall, KIND_V2 } from '../execution/executorCalldata';
import { LoopTrader, loopConfigFromEnv, LoopTrade, LOOP_LIVE_SEND_POSSIBLE } from '../core/loopTrader';
import { loopLogLine } from '../core/loopReport';
import type { LoopEnv } from '../core/loopFinder';
import type { PoolState } from '../core/types';
import type { SimResult } from '../execution/simulator';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1), E18 = 10n ** 18n;
const EXEC = A(0xe0), LENDER = A(0x1e);

function cand(over: Partial<LoopLiveCandidate> = {}, now = 1_000_000): LoopLiveCandidate {
  return {
    sig: 'loop-a', label: 'WETH/USDG/PONS/WETH', base: W, amountIn: E18 / 10n, sizeUsd: 300, netUsd: 1.0,
    poolKeys: [A(11), A(12), A(13)],
    hops: [
      { kind: KIND_V2, pool: A(11), tokenIn: W, tokenOut: A(2), feeBps: 30 },
      { kind: KIND_V2, pool: A(12), tokenIn: A(2), tokenOut: A(3), feeBps: 30 },
      { kind: KIND_V2, pool: A(13), tokenIn: A(3), tokenOut: W, feeBps: 30 },
    ],
    coins: [W, A(2), A(3)], foundAt: now, ...over,
  };
}

interface Rig { s: LoopLiveSender; d: LoopLiveDeps; fired: { to: string; data: string }[]; after: any[]; logs: string[]; alerts: string[]; checks: (string | undefined)[]; t: { now: number } }
function rig(env: Record<string, string> = {}, over: Partial<LoopLiveDeps> = {}, result: SimResult = { status: 'profit', profit: E18 / 1000n }): Rig {
  const t = { now: 1_000_000 };
  const fired: { to: string; data: string }[] = [], after: any[] = [], logs: string[] = [], alerts: string[] = [], checks: (string | undefined)[] = [];
  const d: LoopLiveDeps = {
    now: () => t.now, live: () => true,
    liveBlocker: () => null,
    funding: () => ({ kind: 'own' }),
    waitForTrade: async () => true,
    check: async (_c, lender) => { checks.push(lender); return result; },
    gasUsd: (pools, flash) => 0.03 + (flash ? 0.01 : 0),
    minNetUsd: () => 0.05,
    usdOf: (tk) => (tk === W ? 2_000 : null),   // 0.001 WETH profit = $2.00
    decimalsOf: () => 18,
    isOutlier: (net) => net > 50,
    safety: () => null,
    deadline: () => 12345n,
    ready: () => null,
    gasLimitOk: () => true,
    executor: () => EXEC,
    fire: async (to, data) => { fired.push({ to, data }); return { live: true, txHash: '0x' + 'ab'.repeat(32) }; },
    afterSent: (hash, info) => { after.push({ hash, ...info }); },
    log: (m) => logs.push(m), alert: (h) => alerts.push(h),
    dayOf: (ms) => String(Math.floor(ms / 86_400_000)),
    ...over,
  };
  const s = new LoopLiveSender(loopLiveConfigFromEnv({ LOOP_LIVE: '1', ...env }), d);
  return { s, d, fired, after, logs, alerts, checks, t };
}

(async () => {
  // ---- settings ----
  {
    const c = loopLiveConfigFromEnv({});
    assert(!c.enabled, 'LOOP_LIVE unset: off');
    const on = loopLiveConfigFromEnv({ LOOP_LIVE: '1' });
    assert(on.enabled && on.maxPools === 3 && on.maxPerHour === 20 && on.checksPerHour === 120 && on.lossCapUsd === 2 && on.maxTradeUsd === 10_000,
      'LOOP_LIVE=1 defaults: 3 pools, 20 sends/h, 120 checks/h, $2 loop loss cap, $10,000 max');
    const off = rig({ LOOP_LIVE: '0' });
    await off.s.offer(cand());
    assert(off.fired.length === 0 && off.checks.length === 0, 'LOOP_LIVE=0: nothing checked, nothing sent');
    assert(loopConfigFromEnv({ LOOP_LIVE: '1' }).maxTradeUsd === 10_000 && loopConfigFromEnv({}).maxTradeUsd === 2_000, 'loop finder size cap: $10,000 with live loops (flash loans), $2,000 otherwise');
    assert(LOOP_LIVE_SEND_POSSIBLE === false, 'the loop trader itself still cannot send (only offers to the live sender)');
  }

  // ---- happy path: own money ----
  {
    const r = rig();
    await r.s.offer(cand());
    assert(r.checks.length === 1 && r.checks[0] === undefined, 'real check run with own money (no lender)');
    assert(r.fired.length === 1 && r.fired[0].to === EXEC && r.fired[0].data.startsWith(EXECUTE_SELECTOR), 'sent to the trade contract with execute() (own money)');
    const dec = decodeExecuteCall(r.fired[0].data);
    const tr = dec[0];
    // check: 0.001 WETH = $2.00 before gas, gas $0.03 -> $1.97; guess $1.00 -> send on the smaller: $1.00
    assert(tr.amountIn === E18 / 10n && tr.maxBlock === 12345n && tr.hops.length === 3, 'amount, deadline and 3 hops in the call');
    assert(tr.minProfit === E18 / 2000n, `profit floor = the smaller of guess and check ($1.00 = 0.0005 WETH): ${tr.minProfit}`);
    assert(r.after.length === 1 && r.after[0].label === 'loop WETH/USDG/PONS/WETH' && r.after[0].funding.kind === 'own' && Math.abs(r.after[0].netUsd - 1) < 1e-9, 'bookkeeping after the send: labelled "loop ...", own money, $1.00');
    assert(r.s.isLoopTrade('0x' + 'ab'.repeat(32)), 'our loop trade is remembered (for its result)');
    assert(r.s.hourLine().includes('sent 1'), 'hour line counts the send');
  }

  // ---- flash loan when the wallet is short ----
  {
    const r = rig({}, { funding: (): LoopFunding => ({ kind: 'flash', lender: LENDER, feePips: 100 }) });
    await r.s.offer(cand({ sizeUsd: 5_000 }));
    assert(r.checks[0] === LENDER, 'real check run WITH the flash loan (same lender)');
    assert(r.fired.length === 1 && r.fired[0].data.startsWith(EXECUTE_V3_FLASH_SELECTOR) && r.fired[0].data.toLowerCase().includes(LENDER.slice(2).padStart(64, '0')), 'sent with executeWithV3Flash and the chosen lender');
    assert(r.after[0].funding.kind === 'flash', 'bookkeeping says flash loan');
    const none = rig({}, { funding: () => null });
    await none.s.offer(cand());
    assert(none.checks.length === 0 && none.s.hourLine().includes('no own money and no usable lender'), 'no money and no lender: not checked, not sent');
  }

  // ---- check first ----
  {
    const loss = rig({}, {}, { status: 'loss' });
    for (let i = 0; i < 3; i++) { await loss.s.offer(cand({ foundAt: loss.t.now })); loss.t.now += 1_000; }
    assert(loss.fired.length === 0 && loss.checks.length === 3, 'real check says loss: never sent (3 checks)');
    await loss.s.offer(cand({ foundAt: loss.t.now }));
    assert(loss.checks.length === 3, 'after 3 failed checks in a row the loop is not checked again (30 min)');
    loss.t.now += 31 * 60_000;
    await loss.s.offer(cand({ foundAt: loss.t.now }));
    assert(loss.checks.length === 4, 'after 30 minutes it is checked again');
    const small = rig({}, {}, { status: 'profit', profit: E18 / 50_000n }); // $0.04 before gas
    await small.s.offer(cand());
    assert(small.fired.length === 0, 'real profit under gas + send minimum: not sent');
    const noLand = rig({}, { waitForTrade: async () => false });
    await noLand.s.offer(cand({ triggerHash: '0x' + '11'.repeat(32) }));
    assert(noLand.checks.length === 0 && noLand.fired.length === 0, 'followed trade not in a block in time: not checked, not sent');
    let waited = '';
    const land = rig({}, { waitForTrade: async (h) => { waited = h; return true; } });
    await land.s.offer(cand({ triggerHash: '0x' + '22'.repeat(32) }));
    assert(waited === '0x' + '22'.repeat(32) && land.fired.length === 1, 'waits for the trade that opened the loop, then checks and sends');
  }

  // ---- guards ----
  {
    const cases: [string, Partial<LoopLiveDeps>, Partial<LoopLiveCandidate>, string][] = [
      ['exchange or coin not cleared for live', { liveBlocker: () => 'exchange not cleared' }, {}, 'not cleared for live'],
      ['outlier profit', {}, {}, ''],
      ['safety gate refuses', { safety: () => 'daily loss cap reached' }, {}, 'safety gate'],
      ['live checks not passed', { ready: () => 'live checks not passed' }, {}, 'live checks not passed'],
      ['block info stale', { deadline: () => null }, {}, 'block info stale'],
      ['sender gas limit too low', { gasLimitOk: () => false }, {}, 'gas limit'],
      ['found too long ago', {}, { foundAt: 1_000_000 - 5_000 }, 'found too long ago'],
      ['over the loop size limit', {}, { sizeUsd: 20_000 }, 'size limit'],
      ['4 pools (live is 3 pools only)', {}, { hops: [...cand().hops, cand().hops[2]] }, 'more than 3 pools'],
    ];
    for (const [name, deps, c, why] of cases) {
      const r = name === 'outlier profit' ? rig({}, {}, { status: 'profit', profit: E18 / 10n }) : rig({}, deps); // outlier: $200 profit
      await r.s.offer(cand(c));
      const line = r.s.hourLine();
      assert(r.fired.length === 0 && (why === '' || line.includes(why)), `${name}: not sent${why ? ` (${why})` : ''}`);
    }
  }

  // ---- limits ----
  {
    const r = rig({ LOOP_LIVE_MAX_PER_HOUR: '1' });
    await r.s.offer(cand({ sig: 'a' }));
    await r.s.offer(cand({ sig: 'b', poolKeys: [A(41), A(42), A(43)] }));
    assert(r.fired.length === 1 && r.s.hourLine().includes('hourly send limit'), 'LOOP_LIVE_MAX_PER_HOUR=1: second loop not sent');
    r.t.now += 3601_000;
    await r.s.offer(cand({ sig: 'c', foundAt: r.t.now, poolKeys: [A(51), A(52), A(53)] }));
    assert(r.fired.length === 2, 'next hour: sends again');
    let release: () => void = () => {};
    const slow = rig({}, { check: () => new Promise<SimResult>((res) => { release = () => res({ status: 'profit', profit: E18 / 1000n }); }) });
    const first = slow.s.offer(cand({ sig: 'x' }));
    await slow.s.offer(cand({ sig: 'y' }));
    release(); await first;
    assert(slow.fired.length === 1 && slow.s.hourLine().includes('another loop is being checked'), 'one loop at a time: a second loop while one is being checked is skipped');
  }

  // ---- in flight: the same loop (or a loop on the same pools) is not sent twice ----
  {
    const r = rig();
    await r.s.offer(cand({ sig: 'a' }));
    await r.s.offer(cand({ sig: 'a', foundAt: r.t.now }));
    await r.s.offer(cand({ sig: 'other', poolKeys: [A(99), A(12), A(98)], foundAt: r.t.now }));
    assert(r.fired.length === 1 && r.s.hourLine().includes('still in flight'), 'same loop / shared pool while the first is in flight: not sent again');
    r.s.noteResult({ hash: '0x' + 'ab'.repeat(32), status: 'profit', gasUsd: 0.03, profitUsd: 1, label: 'loop x' });
    await r.s.offer(cand({ sig: 'a', foundAt: r.t.now }));
    assert(r.fired.length === 2, 'after it settled: can be sent again');
    // Loss cap counts trades in flight: $1.99 lost + $0.03 in flight would pass $2.
    const c = rig();
    await c.s.offer(cand({ sig: 'a' }));
    c.s.noteResult({ hash: '0x' + 'ab'.repeat(32), status: 'reverted', gasUsd: 1.95, label: 'loop x' });
    let n = 0;
    c.d.fire = async (to, data) => { c.fired.push({ to, data }); n++; return { live: true, txHash: '0x' + String(n).padStart(64, '0') }; };
    await c.s.offer(cand({ sig: 'b', poolKeys: [A(61), A(62), A(63)], foundAt: c.t.now }));
    await c.s.offer(cand({ sig: 'c', poolKeys: [A(71), A(72), A(73)], foundAt: c.t.now }));
    assert(c.fired.length === 2 && c.s.hourLine().includes('counting trades in flight'), 'loss cap counts the gas of loops still in flight');
    // Measured gas from the check must fit the sender limit too.
    const g = rig({}, { gasLimitOk: (u) => u < 900_000 }, { status: 'profit', profit: E18 / 1000n, gasUsed: 950_000n });
    await g.s.offer(cand());
    assert(g.fired.length === 0 && g.s.hourLine().includes('(measured)'), 'check measured more gas than the sender limit allows: not sent');
    const bad = rig();
    await bad.s.offer(cand({ base: A(2) }));
    assert(bad.fired.length === 0 && bad.s.hourLine().includes('base coin'), 'route that does not start and end in the base coin: not sent');
    const boom = rig({}, { funding: () => { throw new Error('boom'); } });
    await boom.s.offer(cand());
    await boom.s.offer(cand({ sig: 'z', foundAt: boom.t.now }));
    assert(boom.s.hourLine().includes('error 2'), 'an error in a check is caught and the lock released (2 tries, 2 errors)');
  }

  // ---- loop loss cap ----
  {
    const r = rig();
    await r.s.offer(cand({ sig: 'a' }));
    const hash = '0x' + 'ab'.repeat(32);
    r.s.noteResult({ hash, status: 'reverted', gasUsd: 2.5, label: 'loop x' });
    assert(r.s.pausedToday() && r.alerts.length === 1 && r.alerts[0].includes('LIVE LOOPS PAUSED'), '$2.50 gas lost on a failed loop: live loops paused, Telegram alert');
    await r.s.offer(cand({ sig: 'b', foundAt: r.t.now }));
    assert(r.fired.length === 1 && r.s.hourLine().includes('loop loss cap'), 'paused: no more loop sends today');
    r.s.noteResult({ hash: '0x' + 'cd'.repeat(32), status: 'reverted', gasUsd: 9, label: 'other' });
    assert(r.s.lossTodayUsd() === 2.5, "a 2-pool trade's result does not count toward the loop cap");
    r.t.now += 86_400_000;
    await r.s.offer(cand({ sig: 'c', foundAt: r.t.now }));
    assert(!r.s.pausedToday() && r.fired.length === 2, 'next day: live loops run again');
    const w = rig();
    await w.s.offer(cand());
    w.s.noteResult({ hash: '0x' + 'ab'.repeat(32), status: 'profit', gasUsd: 0.03, profitUsd: 1.2, label: 'loop x' });
    assert(w.s.hourLine().includes('won 1 ($1.20)'), 'a winning loop is counted with its profit');
  }

  // ---- practice mode (bot not live): dry run only ----
  {
    const r = rig({}, { live: () => false, fire: async (to, data) => { return { live: false }; } });
    await r.s.offer(cand());
    assert(r.after.length === 0 && r.s.hourLine().includes('dry run 1'), 'bot not live: checked and signed as a dry run, nothing sent');
  }

  // ---- hand-over from the loop trader ----
  {
    let clock = 5_000_000;
    const env: LoopEnv = { decimalsOf: () => 18, usdOf: (t) => (t.toLowerCase() === W ? 1 : null), depthUsd: () => 1_000_000, gasUsd: (h) => 0.01 * h, isTradable: () => true, now: () => clock };
    const v2 = (addr: number, tA: string, tB: string, rA: number, rB: number): PoolState => ({
      chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
      reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n, feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: clock,
    });
    const tick = () => new Promise<void>((r) => setImmediate(r));
    const offered: LoopLiveCandidate[] = [];
    const checks: LoopTrade[] = [];
    const mk = (tradable: boolean) => new LoopTrader(loopConfigFromEnv({ LOOP_TRADER: '1', LOOP_LIVE: '1' }), {
      env: { ...env, isTradable: () => tradable }, bases: [W], symbolOf: (t) => (t === W ? 'WETH' : 'T' + parseInt(t.slice(-4), 16)), decimalsOf: () => 18,
      canPracticeTest: () => true, canCheckNow: () => true,
      runCheck: async (t) => { checks.push(t); return { status: 'loss' }; },
      liveOffer: (c) => { offered.push(c); return true; },
    });
    const t = mk(true);
    t.onUpdate([v2(21, W, A(100), 1_000, 2_000), v2(22, A(100), A(101), 2_000, 2_000), v2(23, A(101), W, 1_000, 1_300)]);
    await tick(); await tick();
    assert(offered.length === 1 && checks.length === 0, '3-pool loop on vetted coins: handed to the live sender, no practice check');
    const c = offered[0];
    assert(c.hops.length === 3 && c.poolKeys.join() === [A(21), A(22), A(23)].join() && c.base === W && c.amountIn > 0n && c.coins.length === 3,
      'hand-over carries the contract hops, pools, base coin, size and coins');
    const h = t.takeHour();
    assert(h.liveOffered === 1 && loopLogLine(h, 5, 'hour').includes('handed to live 1'), 'loop hour line: "handed to live 1"');
    // Unvetted coins: practice check only, never offered.
    offered.length = 0;
    clock += 120_000;
    const u = mk(false);
    u.onUpdate([v2(31, W, A(200), 1_000, 2_000), v2(32, A(200), A(201), 2_000, 2_000), v2(33, A(201), W, 1_000, 1_300)]);
    await tick(); await tick();
    assert(offered.length === 0 && checks.length === 1, 'coin not vetted: practice check only, never offered for live');
  }
})();
