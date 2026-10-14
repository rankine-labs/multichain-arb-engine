// Tests for the stall finder (core/stallFinder.ts):
//   - a synthetic 120 ms freeze inside a named job is found and blamed on that job
//   - the first part of an async job is timed; unexplained freezes say which
//     slow job was in progress
//   - nested jobs: the outer job is not blamed for the inner job's time
//   - memory clean-ups (GC) that overlap a freeze are listed as "GC"
//   - the 5-minute log line / hourly Telegram lines read as expected
// Timing checks use generous bounds (the server runs these during deploys).
import { StallFinder, formatStallLine, formatStallDetail, MAX_STALLS } from '../core/stallFinder';
import { formatPlainHourly } from '../core/telegramFormatter';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Hold the thread for `ms` (what a heavy job does).
const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };

async function main() {
  // ---------------------------------------------------------------------------
  // 1) Real detector: a 120 ms busy-wait in a named job
  // ---------------------------------------------------------------------------
  {
    const f = new StallFinder({ enabled: true }).start();
    await sleep(60);            // let the 20 ms ticks settle
    f.take('fiveMin');          // start from a clean window
    f.run('synthetic job', () => busy(120));
    await sleep(80);            // the late tick arrives right after the freeze
    const s = f.take('fiveMin');
    const c = s.causes.find((x) => x.name === 'synthetic job');
    assert(s.freezes >= 1 && s.worstMs >= 60, `120 ms busy-wait is seen as a freeze (${s.freezes}x, worst ${Math.round(s.worstMs)} ms)`);
    assert(!!c && c.maxMs >= 90, `freeze blamed on "synthetic job" (${c ? Math.round(c.maxMs) : 'none'} ms)`);
    assert(s.causes[0]?.name === 'synthetic job', `"synthetic job" is the top cause (${s.causes.map((x) => x.name).join(', ')})`);
    assert(s.longest[0]?.name === 'synthetic job' && s.longest[0].maxMs >= 119, 'longest single step: synthetic job (~120 ms)');

    // Async job: the part before its first wait is what freezes the bot.
    await f.runAsync('async job', async () => { busy(100); await sleep(1); });
    await sleep(60);
    const a = f.take('fiveMin');
    assert(a.causes.some((x) => x.name === 'async job' && x.maxMs >= 70), `async job's first stretch blamed (${a.causes.map((x) => `${x.name} ${Math.round(x.maxMs)}`).join(', ')})`);

    // Unwrapped work while a slow job is in progress: "other (during ...)".
    const slow = f.runAsync('slow download', () => sleep(400));
    await sleep(30);
    busy(110);
    await sleep(60);
    const o = f.take('fiveMin');
    await slow;
    assert(o.causes.some((x) => x.name === 'other (during slow download)'), `unexplained freeze names the job in progress (${o.causes.map((x) => x.name).join(', ')})`);
    // A job not marked as "in progress" (feed trades) is never named that way.
    const feed = f.runAsync('feed trade', () => sleep(300), false);
    await sleep(30);
    busy(110);
    await sleep(60);
    const o2 = f.take('fiveMin');
    await feed;
    assert(o2.causes.some((x) => x.name === 'other') && !o2.causes.some((x) => x.name.includes('feed trade')), 'untracked async job is not listed as "in progress"');
    f.stop();
  }

  // ---------------------------------------------------------------------------
  // 2) Attribution rules (no real timing: times given by hand)
  // ---------------------------------------------------------------------------
  {
    const f = new StallFinder({ enabled: true });   // not started: no detector
    const t = performance.now() + 1_000;
    // Freeze 1: 120 ms, explained by "loop rebuild" (100 ms) + a bit of unexplained.
    f.noteSlice('loop rebuild', t + 10, t + 110);
    f.recordStall(t, t + 140, 120);
    // Freeze 2: 400 ms, explained by "extra-pool pick".
    f.noteSlice('extra-pool pick', t + 1_000, t + 1_400);
    f.recordStall(t + 990, t + 1_420, 400);
    // Freeze 3: 80 ms, a major GC of 70 ms.
    f.recordStall(t + 2_000, t + 2_100, 80);
    f.noteGc(t + 2_010, 70, 'major');
    f.noteGc(t + 5_000, 2, 'minor');
    // Nested: "hourly report" (60 ms) called "mem report" (50 ms) inside it.
    const nf = new StallFinder({ enabled: true });
    const end = nf.begin('hourly report');
    nf.run('mem report', () => busy(50));
    busy(10);
    end();
    nf.recordStall(performance.now() - 80, performance.now(), 60);
    const ns = nf.take('fiveMin', performance.now() + 1);
    const outer = ns.causes.find((x) => x.name === 'hourly report'), inner = ns.causes.find((x) => x.name === 'mem report');
    assert(!!inner && inner.maxMs >= 45 && !!outer && outer.maxMs < 30, `nested job: the inner job gets its own time, not the outer one (outer ${outer ? Math.round(outer.maxMs) : '-'} ms, inner ${inner ? Math.round(inner.maxMs) : '-'} ms)`);

    const s = f.take('hour', t + 10_000);
    assert(s.freezes === 3 && Math.round(s.worstMs) === 400, '3 freezes, worst 400 ms');
    const names = s.causes.map((c) => c.name);
    assert(names[0] === 'extra-pool pick' && names.includes('loop rebuild') && names.includes('GC'), `causes ranked (${names.join(', ')})`);
    assert(!names.some((n) => n.startsWith('other')), 'freezes fully explained: no "other"');
    assert(s.gc.n === 2 && s.gc.major === 1 && Math.round(s.gc.maxMs) === 70 && s.gc.maxKind === 'major', 'GC totals: 2 clean-ups, 1 major, worst 70 ms');

    const line = formatStallLine(s);
    assert(line === 'Freezes over 50 ms: 3 (worst 400 ms) · top causes: extra-pool pick 1x (max 400 ms), loop rebuild 1x (max 100 ms), GC 1x (max 70 ms)', `log line: ${line}`);
    const detail = formatStallDetail(s);
    assert(detail.startsWith('Memory clean-up (GC): 2x, 72 ms in total, worst 70 ms (major), 1 major · longest single steps: extra-pool pick 400 ms, loop rebuild 100 ms'), `detail line: ${detail}`);
    assert(!/—/.test(line + detail), 'no em dashes in report text');
    // Window reset: the next hour starts empty.
    const empty = f.take('hour', t + 20_000);
    assert(formatStallLine(empty) === 'Freezes over 50 ms: none' && empty.gc.n === 0, 'fresh window after take(): "none"');
    assert(formatStallLine({ ...empty, enabled: false }) === 'Freezes: stall finder off (STALL_FINDER=0)' && formatStallDetail({ ...empty, enabled: false }) === '', 'off switch is reported plainly');
    // Bounded memory: thousands of freezes never grow the list without limit.
    // (Oct 14: the list holds MAX_STALLS, trimmed in batches of 500.)
    for (let i = 0; i < 20_000; i++) f.recordStall(t + 30_000 + i, t + 30_000 + i + 0.5, 60);
    assert((f as any).stalls.length <= MAX_STALLS + 500, 'freeze list is bounded');
  }

  // ---------------------------------------------------------------------------
  // 3) Hourly Telegram report shows the two lines under the speed lines
  // ---------------------------------------------------------------------------
  {
    const base = {
      windowLabel: '13:06 to 13:56', live: false, feedOk: true, feedReconnects: 0,
      pairs: 60, spots: 261, pricesFrom: 'free' as const, freeNodeBusy: 2, differencesFound: 93,
      checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 3 }, checksAvailable: false,
      earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
      reactionMs: { typical: 40, slowest5pct: 90 },
      otherBots: { timed: 0, theirMs: null, oursMs: null, weBeat: 0 },
      topDifferences: [],
      speed: { median: 'Where the time goes (median): wait+decode 1 ms', p95: 'Where the time goes (p95): wait+decode 40 ms' },
    };
    const msg = formatPlainHourly({ ...base, stalls: ['Freezes over 50 ms: 3 (worst 400 ms) · top causes: extra-pool pick 1x (max 400 ms)', 'Memory clean-up (GC): 2x, 72 ms in total'] });
    const i = msg.indexOf('Freezes over 50 ms: 3'), j = msg.indexOf('Slowest 5%');
    assert(i > 0 && j > 0 && i > j && msg.includes('Memory clean-up (GC): 2x'), 'hourly report: freeze lines right after the speed lines');
    assert(!formatPlainHourly(base).includes('Freezes'), 'hourly report: no freeze lines when not given');
  }
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
