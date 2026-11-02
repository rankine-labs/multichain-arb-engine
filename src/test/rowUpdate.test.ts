import { entrySettings, tableRowUpdOn, rowUpdateOf } from '../execution/trigEntry';
import { Row, canon, asArb, universe, entryWith, botView, arbView, noIds, sameMap } from './rowUpdateHarness';

// ============================================================================
// ROW UPDATES (Nov 2, fix 10, TRIG_TABLE_ROW_UPDATE, default on; 0 = exactly
// the true delta table).
//
// Plain English: live, arbsim still got 80 to 99 MB of table messages every
// 5 minutes after true delta, almost all of it ~950 whole pools re-sent
// for gas / WETH-price drift (see execution/trigEntry.ts ROW UPDATES). Now
// a drifted row goes as only its changed parts. These checks run the bot's
// real table code in the same live-shaped universe as trueDelta.test.ts
// (copied here), with a fake arbsim that applies messages exactly like
// check/entry.rs apply_table (scores, then row updates, then whole rows;
// a check merged key by key; keys compared as arbsim stores them, sorted),
// and prove:
//   1. rowUpdateOf: applying the update to the held row gives EXACTLY the
//      fresh row; rows it can't express go whole (null).
//   2. Same live run, row updates on vs off: arbsim holds EXACTLY what the
//      bot thinks after every pass (both), EXACTLY a fresh full build once
//      drift has gone (both), the same pools change on the same passes, and
//      far fewer bytes with row updates.
//   3. An arbsim that reads patches but not row updates never gets one
//      (whole rows / pools as before, still exact).
//   4. TRIG_TABLE_ROW_UPDATE=0: byte-for-byte the true delta messages.
//   5. A refused message / an arbsim restart: a full table, exact again.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  const live = { LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0', FASTLANE: 'live', TRIG_ENTRY_NODE_ASKS: 'off', TRIG_ENTRY_TABLE_MAX_BYTES: '400000', TRIG_ENTRY_TABLE_REUSE_MS: '30000' };
  const GROUPS = 16, PER = 8;

  // ---- settings ----
  assert(tableRowUpdOn({}) && !tableRowUpdOn({ TRIG_TABLE_ROW_UPDATE: '0' }) && !tableRowUpdOn({ TRIG_TABLE_DELTA: '0' }) && entrySettings({}).tableRowUpd && !entrySettings({ TRIG_TABLE_ROW_UPDATE: '0' }).tableRowUpd,
    'TRIG_TABLE_ROW_UPDATE: on by default; 0 (or true delta off) = the true delta table exactly');

  // ---- 1. rowUpdateOf ----
  {
    const c0 = { calls: [{ to: '0xa', data: '0x12' }], overrides: { '0xb': { code: '$code:0' } }, route: ['0xp'], stop: '0x1', amt: '0x10' };
    const held = { rid: 'a>b:u', h: true, s: 1.5, e: '3.7', c: c0, f: { px: 1, g: 0.01 } };
    const now = { rid: 'a>b:u', h: true, s: 2.5, e: '', c: { ...c0, stop: '0x2' }, f: { px: 1, g: 0.02 } };
    const u = rowUpdateOf(held, now)!;
    assert(!!u && canon(u.c) === canon({ stop: '0x2' }) && u.s === 2.5 && canon(u.f) === canon(now.f) && !('h' in u) && !('e' in u),
      `rowUpdateOf: only the changed parts (${JSON.stringify(u)})`);
    const merged = asArb({ ...held, ...('s' in u ? { s: u.s } : {}), ...('f' in u ? { f: u.f } : {}), c: { ...held.c, ...(u.c as object) }, e: '9.9' });
    assert(canon(merged) === canon(asArb({ ...now, e: '9.9' })), 'rowUpdateOf: held row + update = the fresh row exactly');
    assert(Object.keys(rowUpdateOf(held, { ...now, s: 1.5, f: held.f, c: c0 })!).join() === 'rid', 'nothing changed: an update with only the route id');
    assert(rowUpdateOf(held, { ...now, c: null }) === null && rowUpdateOf({ ...held, c: null }, now) === null, 'no check on either side: goes whole');
    assert(rowUpdateOf(held, { ...now, c: { ...c0, sizes: [1] } }) === null && rowUpdateOf(held, { ...now, c: { calls: c0.calls, overrides: c0.overrides, route: c0.route, stop: '0x2' } }) === null, 'check keys differ (one added / gone): goes whole');
    assert(rowUpdateOf(held, { ...now, e: null }) === null && rowUpdateOf({ ...held, e: null }, now) === null, 'not buildable on either side: goes whole');
    assert(rowUpdateOf(held, { ...now, x: 1 }) === null, 'a row field arbsim does not know: goes whole');
    const u2 = rowUpdateOf(held, { ...now, f: undefined })!;
    assert(u2 && u2.f === null, 'facts gone: sent as null (arbsim then holds none, as a whole row without facts)');
    const u3 = rowUpdateOf(held, { ...now, s: null })!;
    assert(u3 && u3.s === null, 'score gone: sent as null');
  }

  // ---- 2, 4. the live condition: row updates off vs on ----
  const tradesAt = (r: number, n: number) => (r % 3 === 2 ? [] : [(r * 37 + 5) % n, (r * 53 + 11) % n]);
  // Quiet / drift window 60 s here (10 min live) so drift falls due many times in the run.
  const runLive = async (env: Record<string, string>, passes: number, arb = { patches: true, upd: true }) => {
    const u = universe(GROUPS, PER);
    const c = { t: 1_000_000 };
    const E = entryWith(env, u.table, c, arb);
    await E.te.refreshTable();
    const first = E.A.log.length;
    let exactEveryPass = true;
    const changedPerPass: string[] = [];
    for (let r = 0; r < passes; r++) {
      const moving = r < passes - 20; // the last 20 passes: gas / price still, so every pool's quiet turn (8 a pass) and drift come
      u.tick(r, { trades: moving ? tradesAt(r, u.n) : [], drift: moving });
      c.t += 10_000;
      const before = E.A.log.length;
      await E.te.refreshTable();
      changedPerPass.push(E.A.log.slice(before).flatMap((m) => m.keys).sort().join(','));
      if (!sameMap(botView(E.T()), arbView(E.A.rows()))) exactEveryPass = false;
    }
    const after = E.A.log.slice(first);
    return { u, E, exactEveryPass, changedPerPass, msgs: after.length, bytes: after.reduce((a, m) => a + m.bytes, 0), upds: after.reduce((a, m) => a + m.upds, 0), fulls: after.filter((m) => m.full).length, refused: after.filter((m) => !m.ok).length, texts: E.A.msgs.slice() };
  };
  const env60 = { ...live, TRIG_TABLE_QUIET_MS: '60000' };
  const P = 54;
  const off = await runLive({ ...env60, TRIG_TABLE_ROW_UPDATE: '0' }, P);
  const on = await runLive(env60, P);
  // Reference: a fresh full build of the same universe at the end.
  const ref = await (async () => {
    const u = universe(GROUPS, PER); const c = { t: 1_000_000 };
    const R = entryWith({ ...live, TRIG_TABLE_FAST: '0' }, u.table, c);
    await R.te.refreshTable();
    for (let r = 0; r < P; r++) { const moving = r < P - 20; u.tick(r, { trades: moving ? tradesAt(r, u.n) : [], drift: moving }); c.t += 10_000; await R.te.refreshTable(); }
    return R;
  })();
  const kb = (b: number) => `${Math.round(b / 1024)} KB`;
  console.log(`  (test numbers) ${P} passes: row updates off ${kb(off.bytes)} in ${off.msgs} messages; on ${kb(on.bytes)} in ${on.msgs} messages, ${on.upds} row updates`);
  assert(on.upds > 0 && off.upds === 0, `row updates are used when drift falls due (${on.upds} rows), never with TRIG_TABLE_ROW_UPDATE=0`);
  assert(on.exactEveryPass && off.exactEveryPass, 'after every pass arbsim holds EXACTLY what the bot thinks it holds (row updates on and off; entry ids included)');
  assert(sameMap(noIds(on.E.A.rows()), noIds(ref.A.rows())) && sameMap(noIds(off.E.A.rows()), noIds(ref.A.rows())), `once drift has gone, arbsim holds EXACTLY a fresh full build (both; ${on.E.A.rows().size} pools)`);
  assert(on.changedPerPass.every((x, i) => x === off.changedPerPass[i]), 'same timing: the same pools reach arbsim on the same passes with row updates on as off');
  assert(on.bytes * 2 <= off.bytes, `bytes to arbsim: ${kb(off.bytes)} -> ${kb(on.bytes)} (${(off.bytes / Math.max(1, on.bytes)).toFixed(1)}x less)`);
  assert(on.refused === 0 && on.fulls === 0 && off.refused === 0 && off.fulls === 0, 'no message refused, no full table re-sent (both)');

  // ---- 4. TRIG_TABLE_ROW_UPDATE=0 sends exactly the true delta messages ----
  {
    // The true delta code is the same code with no row updates: an arbsim that never says "upd".
    const noUpd = await runLive(env60, P, { patches: true, upd: false });
    assert(noUpd.texts.length === off.texts.length && noUpd.texts.every((t, i) => t === off.texts[i]), `TRIG_TABLE_ROW_UPDATE=0 and an arbsim without row updates send byte-for-byte the same ${off.texts.length} messages`);
    assert(noUpd.exactEveryPass && noUpd.upds === 0 && noUpd.refused === 0, '3. an arbsim that reads patches but not row updates never gets one, and is exact after every pass');
    const oldArb = await runLive(env60, 24, { patches: false, upd: false });
    assert(oldArb.exactEveryPass && oldArb.upds === 0 && oldArb.refused === 0, 'an arbsim without patches: whole pools, exact after every pass');
  }

  // ---- 5. refused message / arbsim restart ----
  {
    const u = universe(GROUPS, PER);
    const c = { t: 1_000_000 };
    const E = entryWith(env60, u.table, c);
    await E.te.refreshTable();
    for (let r = 0; r < 10; r++) { u.tick(r, { trades: tradesAt(r, u.n) }); c.t += 10_000; await E.te.refreshTable(); }
    E.A.failNext();
    u.tick(10, { trades: [3] }); c.t += 10_000; await E.te.refreshTable();
    u.tick(11, { trades: [] }); c.t += 10_000; await E.te.refreshTable();
    assert(E.A.log.filter((m) => m.full && m.ok).length === 2 && sameMap(botView(E.T()), arbView(E.A.rows())), 'a refused message: a full table next, then exact');
    E.A.restart();
    for (let r = 12; r < 20; r++) { u.tick(r, { trades: tradesAt(r, u.n) }); c.t += 10_000; await E.te.refreshTable(); }
    assert(sameMap(botView(E.T()), arbView(E.A.rows())) && E.A.rows().size === u.n, 'arbsim restarted: full table, then exact again (row updates resume)');
  }

  // ---- the 5-minute table line ----
  {
    const u = universe(4, 4);
    const c = { t: 1_000_000 };
    const E = entryWith(live, u.table, c);
    const real = Date.now;
    let fake = real();
    (Date as any).now = () => fake;
    try {
      await E.te.refreshTable();
      fake += 301_000;
      u.tick(0, { trades: [1] }); c.t += 10_000; await E.te.refreshTable();
    } finally { (Date as any).now = real; }
    const line = E.lines.find((l) => l.startsWith('[trig-entry] table 5 min:')) ?? '';
    assert(/drift rows \d+ sent \/ \d+ waiting; row updates on: \d+ rows/.test(line), `5-minute table line says row updates: "${line}"`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
