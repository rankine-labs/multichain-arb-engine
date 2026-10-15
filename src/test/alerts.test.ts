import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AlertCenter, AlertSpec, formatProblem, formatFixed, formatDuration, escText, reportV2On } from '../report/alerts';
import { AlertWatch } from '../report/alertWatch';
import { AlertHooks, restartReason } from '../report/alertHooks';
import { SafetyAlerts } from '../execution/safetyAlerts';

// Instant Telegram alerts: dedupe, cooldown, FIXED with duration, flap
// filter, rate limit + summary, critical never held back, plain formatting
// (HTML escaped, no em dashes), never blocks, and the watch rules.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const MIN = 60_000;
let clock = 1_760_000_000_000;
const now = () => clock;
const time = () => '15:42';   // fixed label so messages are predictable

function makeCenter(extra: Partial<ConstructorParameters<typeof AlertCenter>[0]> = {}) {
  const out: string[] = [];
  const c = new AlertCenter({ send: (h) => { out.push(h); }, now, timeLabel: time, log: () => {}, ...extra });
  return { c, out };
}

const FEED: AlertSpec = {
  title: 'Live trade feed disconnected', severity: 'high',
  meaning: "we can't see trades early, so we'll win fewer races",
  happening: 'reconnecting automatically',
};

async function main() {
  // --- Formatting -----------------------------------------------------------
  const p = formatProblem(FEED, clock, time);
  console.log('--- example PROBLEM:\n' + p);
  assert(p === "🚨 <b>PROBLEM</b> · Live trade feed disconnected\n15:42 · High\nWhat it means: we can't see trades early, so we'll win fewer races\nWhat's happening: reconnecting automatically", 'PROBLEM message matches the approved style');
  const f = formatFixed('Live trade feed back', 38_000, 'was down');
  console.log('--- example FIXED:\n' + f);
  assert(f === '✅ <b>FIXED</b> · Live trade feed back (was down 38 s)', 'FIXED message matches the approved style');
  const nasty = formatProblem({ title: 'Pool <A&B> \u2014 broken', severity: 'low', meaning: 'x < y & z > w', happening: 'a \u2013 b' }, clock, time);
  assert(nasty.includes('Pool &lt;A&amp;B&gt; - broken') && nasty.includes('x &lt; y &amp; z &gt; w'), 'HTML characters are escaped');
  assert(!/[\u2014\u2013]/.test(nasty), 'no em or en dashes in the output');
  assert(escText('a\u2014b') === 'a - b', 'em dash replaced with a plain hyphen');
  assert(formatDuration(38_000) === '38 s' && formatDuration(4 * MIN) === '4 min' && formatDuration(72 * MIN) === '1 h 12 min', 'durations read naturally');
  assert(reportV2On({}) && !reportV2On({ REPORT_V2: '0' }) && reportV2On({ REPORT_V2: '1' }), 'REPORT_V2 defaults on, 0 turns it off');

  // --- Dedupe ---------------------------------------------------------------
  {
    const { c, out } = makeCenter();
    assert(c.raise('feed', FEED) === 'sent', 'first raise sends');
    clock += 5_000;
    assert(c.raise('feed', FEED) === 'repeat', 'second raise of the same problem is deduped');
    clock += 5_000; c.raise('feed', FEED);
    await c.flush();
    assert(out.length === 1, 'only one message for one ongoing problem');
  }

  // --- Cooldown -------------------------------------------------------------
  {
    const { c, out } = makeCenter();
    c.raise('feed', FEED);
    clock += 14 * MIN;
    assert(c.raise('feed', FEED) === 'repeat', 'no repeat inside the 15 min cooldown');
    clock += 1 * MIN;
    assert(c.raise('feed', FEED) === 'sent', 'repeat after the cooldown');
    await c.flush();
    console.log('--- example STILL A PROBLEM:\n' + out[1]);
    assert(out.length === 2 && out[1]!.includes('STILL A PROBLEM') && out[1]!.includes('(for 15 min)'), 'repeat says STILL A PROBLEM and for how long');
    // A changed problem (new severity) is not held by the cooldown.
    clock += MIN;
    assert(c.raise('feed', { ...FEED, severity: 'medium' }) === 'sent', 'a changed problem sends right away');
  }

  // --- Recovery with duration ----------------------------------------------
  {
    const { c, out } = makeCenter();
    c.raise('feed', FEED);
    clock += 38_000;
    assert(c.clear('feed', 'Live trade feed back', 'was down') === 'sent', 'clear sends FIXED');
    assert(c.clear('feed', 'Live trade feed back', 'was down') === 'none', 'FIXED only once');
    await c.flush();
    assert(out[1] === '✅ <b>FIXED</b> · Live trade feed back (was down 38 s)', 'FIXED says how long it lasted');
  }

  // --- Min duration (flap filter) -------------------------------------------
  {
    const { c, out } = makeCenter();
    const spec = { ...FEED, minDurationMs: 20_000 };
    assert(c.raise('feed', spec) === 'waiting', 'a short blip waits');
    clock += 10_000;
    assert(c.raise('feed', spec) === 'waiting', 'still waiting at 10 s');
    assert(c.clear('feed', 'back') === 'silent', 'cleared before 20 s: nothing sent');
    c.raise('feed', spec); clock += 21_000;
    assert(c.raise('feed', spec) === 'sent', 'down over 20 s: alert sent');
    clock += 9_000; c.clear('feed', 'Live trade feed back', 'was down');
    await c.flush();
    assert(out.length === 2 && out[1]!.includes('was down 30 s'), 'FIXED counts from when it first went down');
  }

  // --- Rate limit + summary + critical never suppressed ---------------------
  {
    const { c, out } = makeCenter({ maxPerHour: 10 });
    for (let i = 0; i < 13; i++) c.event(`e${i}`, { ...FEED, title: `Problem ${i}` });
    assert(c.heldCount === 3, '3 alerts held back after 10 in an hour');
    const crit = c.event('live-fail', { ...FEED, title: 'Live trade failed on-chain', critical: true });
    assert(crit === 'sent', 'critical alert sent even over the rate limit');
    // Critical also skips cooldown: every report goes out.
    c.raise('live-checks', { ...FEED, title: 'Live checks failed', critical: true });
    clock += MIN;
    assert(c.raise('live-checks', { ...FEED, title: 'Live checks failed', critical: true }) === 'sent', 'critical repeat skips the cooldown');
    c.tick();
    await c.flush();
    assert(out.length === 13, '10 normal + 3 critical sent, no summary yet (no room)');
    clock += 61 * MIN;
    c.tick();
    await c.flush();
    const sum = out[out.length - 1]!;
    console.log('--- example summary:\n' + sum);
    assert(sum.includes('TOO MANY ALERTS') && sum.includes('Problem 12') && sum.includes('3 alerts were held back'), 'one summary lists what was held back');
    c.tick(); await c.flush();
    assert(out.length === 14, 'summary sent only once');
  }

  // --- Never blocks: dead / hung / throwing Telegram ------------------------
  {
    let calls = 0;
    const c = new AlertCenter({ send: () => { calls++; throw new Error('telegram down'); }, now, timeLabel: time, log: () => {} });
    let threw = false;
    try { c.raise('x', FEED); c.clear('x', 'ok'); } catch { threw = true; }
    await c.flush();
    assert(!threw && calls === 2, 'a throwing sender never throws back at the caller');
    const hung = new AlertCenter({ send: () => new Promise<void>(() => {}), now, timeLabel: time, log: () => {}, queueMax: 5, sendTimeoutMs: 60_000 });
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) hung.event(`h${i}`, { ...FEED, title: `H${i}` });
    hung.event('crit', { ...FEED, critical: true });
    assert(Date.now() - t0 < 50, 'raising alerts returns at once even when Telegram hangs');
    assert(hung.dropped > 0 && (hung as any).queue.length <= 5, 'queue stays bounded (oldest non-critical dropped)');
    assert((hung as any).queue.some((q: { critical: boolean }) => q.critical), 'critical alert kept in a full queue');
  }

  // --- Watch rules ----------------------------------------------------------
  {
    // Many rules in a row here: lift the hourly limit (tested above).
    const { c, out } = makeCenter({ maxPerHour: 100 });
    let feedOk = true, late = 0, heap = 100, crashes = 0, restarts = 0, capped = false, wsOk = true, node: 'busy' | 'off' | null = null;
    const w = new AlertWatch(c, {
      feedHealthy: () => feedOk,
      wsStatus: () => ({ healthy: wsOk, capped }),
      checkNodePaused: () => node,
      queueTimeoutsTotal: () => late,
      memory: () => ({ heapUsed: heap, heapLimit: 1000, rss: 500 * 1024 * 1024 }),
      loopWorker: () => ({ crashes, restarts }),
    }, { now });
    w.tick();
    feedOk = false; w.tick(); clock += 15_000; w.tick();
    await c.flush();
    assert(out.length === 0, 'feed down 15 s: no alert yet');
    clock += 10_000; w.tick(); await c.flush();
    assert(out.length === 1 && out[0]!.includes('Live trade feed disconnected'), 'feed down 25 s: alert');
    clock += 13_000; feedOk = true; w.tick(); await c.flush();
    console.log('--- example feed FIXED:\n' + out[1]);
    assert(out[1] === '✅ <b>FIXED</b> · Live trade feed back (was down 38 s)', 'feed back: FIXED with "was down 38 s"');

    // Late trades: >10 in 5 min, hourly reset handled.
    late = 5; w.tick(); late = 12; w.tick(); await c.flush();
    assert(out.length === 3 && out[2]!.includes('Many trades too late to test'), 'more than 10 late trades in 5 min: alert');
    late = 0; clock += 6 * MIN; w.tick(); await c.flush();
    assert(out.length === 4 && out[3]!.includes('tested on time again'), 'back to normal after the window clears (reset to 0 handled)');

    // Memory: needs 30 s over 85%.
    heap = 900; w.tick(); clock += 31_000; w.tick(); await c.flush();
    assert(out.length === 5 && out[4]!.includes('Memory use high'), 'memory over 85% for 30 s: alert');
    heap = 820; w.tick(); await c.flush();
    assert(out.length === 5, 'between 80% and 85%: no FIXED yet (no flapping)');
    heap = 500; w.tick(); await c.flush();
    assert(out.length === 6 && out[5]!.includes('Memory back to normal'), 'memory under 80%: FIXED');

    // Loop worker crash then restart.
    crashes = 1; w.tick(); clock += 5_000; restarts = 1; w.tick(); await c.flush();
    assert(out[6]!.includes('Loop finder crashed') && out[7]!.includes('Loop finder restarted and running (was down 5 s)'), 'loop crash then FIXED on restart');
    w.onLoopWarn('[loop] worker restarted 3 times in the last hour: loops paused for 42 min (2-pool trading not affected)');
    w.onLoopWarn('[loop] worker restarted 3 times in the last hour: loops paused for 40 min (2-pool trading not affected)');
    await c.flush();
    assert(out.length === 9 && out[8]!.includes('paused'), 'loop gave up: one alert per hour');

    // Freeze: > 2 s, at most once per 30 min.
    w.onFreeze(1_500); w.onFreeze(2_400, 'block reader apply'); clock += 10 * MIN; w.onFreeze(3_000);
    await c.flush();
    assert(out.length === 10 && out[9]!.includes('Bot froze for 2.4 s') && out[9]!.includes('block reader apply'), 'freeze over 2 s alerted once, short and repeat freezes skipped');

    // Practice node paused > 2 min.
    node = 'busy'; w.tick(); clock += 60_000; w.tick(); await c.flush();
    assert(out.length === 10, 'node paused 1 min: no alert');
    clock += 61_000; w.tick(); node = null; clock += 5_000; w.tick(); await c.flush();
    assert(out[10]!.includes('Practice-test node paused') && out[11]!.includes('Practice-test node working again'), 'node paused over 2 min: alert, then FIXED');

    // Block updates socket: down 60 s, daily cap note once a day.
    wsOk = false; w.tick(); clock += 61_000; w.tick(); wsOk = true; w.tick(); await c.flush();
    assert(out[12]!.includes('Block updates feed down') && out[13]!.includes('Block updates feed back'), 'block updates down over 60 s: alert, then FIXED');
    capped = true; w.tick(); clock += 60_000; w.tick(); await c.flush();
    assert(out.length === 15 && out[14]!.includes('daily limit reached'), 'daily cap: one note');
  }

  // --- Safety alerts in the new style; old style unchanged -----------------
  {
    const msgs: { h: string; crit?: boolean }[] = [];
    const sa = new SafetyAlerts((h, crit) => { msgs.push({ h, crit }); }, 20, 'robinhood', now, true);
    sa.onLoss(16); sa.onLoss(21); sa.onBlocked('kill switch is on', 21);
    console.log('--- example loss cap hit:\n' + msgs[1]?.h);
    assert(msgs.length === 3 && msgs[0]!.h.includes('75% of the daily loss cap used') && !msgs[0]!.crit, 'v2: 75% warning, not critical');
    assert(msgs[1]!.h.includes('Daily loss cap hit') && msgs[1]!.crit === true, 'v2: loss cap hit is critical');
    assert(msgs[2]!.h.includes('Kill switch on') && msgs[2]!.crit === true, 'v2: kill switch is critical');
    const old: string[] = [];
    const sa1 = new SafetyAlerts((h) => { old.push(h); }, 20, 'robinhood', now);
    sa1.onLoss(21);
    assert(old.length === 1 && old[0]!.startsWith('🛑 <b>DAILY LOSS CAP HIT</b>'), 'old style kept when v2 is off');
  }

  // --- Hooks: REPORT_V2=0 sends the old messages, v2 goes through the center
  {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-'));
    const old: string[] = [];
    const h1 = new AlertHooks({ send: (h) => { old.push(h); }, v2: false, dataDir: dir, now });
    h1.liveChecksFailed(['executor role <missing>']);
    h1.lowGas('bot wallet has 0.001 ETH');
    h1.startup(() => 'OLD STARTUP', { robinhood: { online: true } }, false);
    h1.liveTrackerNotify('❌ <b>TRADE REVERTED</b> · x');
    h1.onLiveResult({ status: 'reverted', label: 'x', gasUsd: 0.03, hash: '0xabc' });
    assert(old[0] === '🛑 <b>LIVE CHECKS FAILED</b> · sends blocked\n• executor role missing' && old[1] === '⚠️ <b>LOW GAS</b> · bot wallet has 0.001 ETH'
      && old[2] === 'OLD STARTUP' && old[3]!.includes('TRADE REVERTED') && old.length === 4, 'REPORT_V2=0: old messages word for word, no new ones');
    assert(h1.startWatch({}) === null, 'REPORT_V2=0: no problem watch');

    const out: string[] = [];
    const center = new AlertCenter({ send: (h) => { out.push(h); }, now, timeLabel: time, log: () => {} });
    // Previous run: practice, stopped by pm2 (SIGINT) after its last heartbeat.
    writeFileSync(join(dir, 'alert-state.json'), JSON.stringify({ mode: 'practice', aliveAt: clock - 30_000 }));
    writeFileSync(join(dir, 'last-exit.json'), JSON.stringify({ at: clock - 10_000, code: 0, signal: 'SIGINT' }));
    const h2 = new AlertHooks({ send: () => {}, v2: true, dataDir: dir, now, center, modeReadyWaitMs: 60_000 });
    h2.startup(() => 'OLD', { robinhood: { online: true } }, true);
    h2.liveChecksPassed();
    h2.liveTrackerNotify('❌ <b>TRADE REVERTED</b> · x');
    h2.onLiveResult({ status: 'reverted', label: 'WETH/USDG uniV4>ramses', gasUsd: 0.03, hash: '0xabc' });
    await center.flush();
    console.log('--- example restart:\n' + out[0]);
    console.log('--- example mode change:\n' + out[1]);
    console.log('--- example live trade failed:\n' + out[2]);
    assert(/^🔄 <b>Bot restarted at \d\d:\d\d\.<\/b> Live mode \(real money\)\./.test(out[0]!) && out[0]!.includes('Why: stopped normally (deploy or pm2 restart, SIGINT)'), 'restart message: time, mode and reason');
    assert(out[1]!.includes('MODE CHANGE') && out[1]!.includes('Was: Practice') && out[1]!.includes('Now: Live') && out[1]!.includes('Readiness: live checks passed'), 'mode change: previous, new, readiness');
    assert(out.length === 3 && out[2]!.includes('Live trade failed on-chain') && out[2]!.includes('real money') && out[2]!.includes('$0.03'), 'reverted live trade: one plain critical alert (old one replaced)');
    assert(JSON.parse(readFileSync(join(dir, 'alert-state.json'), 'utf8')).mode === 'live' && !existsSync(join(dir, 'last-exit.json')), 'mode saved, exit file used up');
    assert(!out.join('\n').match(/[\u2014\u2013]/), 'no em dashes in any hook message');
  }

  // --- Restart reasons ------------------------------------------------------
  assert(restartReason({ aliveAt: 100_000 }, null, () => '15:41')!.startsWith('stopped without warning') , 'no exit record: stopped without warning');
  assert(restartReason({ aliveAt: 100_000 }, { at: 101_000, code: 1 }) === 'crashed (exit code 1)', 'non-zero exit code: crashed');
  assert(restartReason(null, null) === null, 'first run: no reason given');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
