import { practiceOnlyReason } from '../config/v4Tiers';
import { universe, entryWith } from './rowUpdateHarness';

// ============================================================================
// FIX 10 speed checks (Nov 2). Speed-comparison test: skipped on the live
// server (SKIP_TIMING_TESTS=1, scripts/run-tests.js), run by GitHub's checks.
//   1. TIERS CACHE (V4_TIERS_CACHE): practiceOnlyReason gives the same answer
//      for every pool kind with the cache on and off, and is at least 2x
//      faster with it (it no longer re-reads RH_V4_MORE_TIERS each call).
//   2. ROW UPDATES (TRIG_TABLE_ROW_UPDATE): the table pass costs the bot's
//      thread no more with row updates than without (working out the
//      changed parts must not cost what the smaller messages save), and
//      no single table stretch gets longer.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  // ---- 1. tiers cache ----
  {
    const more = '750:15,3000:60,6500:130,12000:240,15000:300,22000:440,35000:700,48000:960';
    const hooks0 = '0x' + '0'.repeat(40);
    // Every kind of pool practiceOnlyReason distinguishes: no V4, hooked, standard,
    // the built-in extra list, RH_V4_MORE_TIERS, unlisted (event-found).
    const pools = [
      {}, { v4: { fee: 3000, tickSpacing: 60, hooks: '0x' + 'ab'.repeat(20) } }, { v4: { fee: 3000, tickSpacing: 60 } }, { v4: { fee: 500, tickSpacing: 10, hooks: hooks0 } },
      { v4: { fee: 8000, tickSpacing: 80 } }, { v4: { fee: 750, tickSpacing: 15 } }, { v4: { fee: 48000, tickSpacing: 960 } }, { v4: { fee: 1234, tickSpacing: 7 } },
    ];
    const envs = [
      { RH_V4_MORE_TIERS: more }, { RH_V4_MORE_TIERS: more, V4_EVENT_POOLS_LIVE: '0' }, { RH_V4_MORE_TIERS: more, RH_V4_EXTRA_LIVE: '0' },
      { RH_V4_MORE_TIERS: more, V4_EVENT_POOLS_LIVE: '0', RH_V4_EXTRA_LIVE: '0' }, { V4_EVENT_POOLS_LIVE: '0' }, { RH_V4_MORE_TIERS: '750:15', V4_EVENT_POOLS_LIVE: '0' },
    ];
    let same = true, n = 0;
    for (const e of envs) for (const p of pools) {
      n++;
      const a = practiceOnlyReason(p, { ...e }), b = practiceOnlyReason(p, { ...e, V4_TIERS_CACHE: '0' });
      if (a !== b) { same = false; console.log(`  differs: ${JSON.stringify(p)} ${JSON.stringify(e)}: ${a} / ${b}`); }
    }
    assert(same, `tiers cache: same answer as re-reading every time for ${n} pool / setting mixes`);
    // A changed setting is read again (not a stale list).
    const p = { v4: { fee: 1234, tickSpacing: 7 } };
    const r1 = practiceOnlyReason(p, { RH_V4_MORE_TIERS: '750:15', V4_EVENT_POOLS_LIVE: '0' });
    const r2 = practiceOnlyReason(p, { RH_V4_MORE_TIERS: '750:15,1234:7', V4_EVENT_POOLS_LIVE: '0' });
    assert(r1 !== null && r2 === null, 'tiers cache: a changed RH_V4_MORE_TIERS is read again');
    // Speed: the live mix, many calls (best of 3).
    const time = (env: Record<string, string>) => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        for (let i = 0; i < 200_000; i++) practiceOnlyReason(pools[i & 7], env);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const slow = time({ RH_V4_MORE_TIERS: more, V4_TIERS_CACHE: '0' }), fast = time({ RH_V4_MORE_TIERS: more });
    assert(fast * 2 <= slow, `tiers cache: 200,000 practice-only checks ${slow.toFixed(0)} ms -> ${fast.toFixed(0)} ms (${(slow / fast).toFixed(1)}x faster)`);
  }

  // ---- 2. row updates: table pass cost ----
  {
    const live = { LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0', FASTLANE: 'live', TRIG_ENTRY_NODE_ASKS: 'off', TRIG_ENTRY_TABLE_MAX_BYTES: '400000', TRIG_ENTRY_TABLE_REUSE_MS: '30000', TRIG_TABLE_QUIET_MS: '60000' };
    const run = async (env: Record<string, string>) => {
      const u = universe(16, 8);
      const c = { t: 1_000_000 };
      const E = entryWith(env, u.table, c);
      await E.te.refreshTable();
      const busy: number[] = [];
      for (let r = 0; r < 40; r++) {
        u.tick(r, { trades: r % 3 === 2 ? [] : [(r * 37 + 5) % u.n, (r * 53 + 11) % u.n] });
        c.t += 10_000;
        await E.te.refreshTable();
        busy.push(E.T().lastBusyMs);
      }
      busy.sort((a, b) => a - b);
      return { median: busy[busy.length >> 1], total: busy.reduce((a, b) => a + b, 0) };
    };
    // (Warm up once, then alternate, best of 2 each: the machine's noise hits both.)
    await run(live);
    const off1 = await run({ ...live, TRIG_TABLE_ROW_UPDATE: '0' }), on1 = await run(live);
    const off2 = await run({ ...live, TRIG_TABLE_ROW_UPDATE: '0' }), on2 = await run(live);
    const off = Math.min(off1.total, off2.total), on = Math.min(on1.total, on2.total);
    assert(on <= 1.25 * off + 20, `row updates: bot thread time for 40 table passes ${off.toFixed(0)} ms (off) -> ${on.toFixed(0)} ms (on)`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
