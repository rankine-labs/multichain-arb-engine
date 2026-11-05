import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Copy2ActivePicker, copy2ActiveSettings, feedActiveOnly } from '../execution/copy2Active';

// COPY 2 ACTIVE POOLS (COPY2_ACTIVE_MAX, Nov 5): copy 2 follows only the
// busiest watched pairs. Fake clock, temp file, no network.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), 'c2active-'));
let clock = 1_000_000;
// 4 pairs: A (3 pools), B (2), C (2), D (2); X = a pool in no pair.
const pairs = [['0xa1', '0xa2', '0xa3'], ['0xb1', '0xb2'], ['0xc1', '0xc2'], ['0xd1', '0xd2']];
const keys = ['0xa1', '0xa2', '0xa3', '0xb1', '0xb2', '0xc1', '0xc2', '0xd1', '0xd2', '0xx1'];
let events = new Map<string, number>();
const money: Record<string, number> = { '0xd1': 9e6, '0xd2': 9e6, '0xc1': 5e5, '0xc2': 5e5 };
const logs: string[] = [];
const mk = (env: Record<string, string>) => new Copy2ActivePicker(copy2ActiveSettings({ COPY2_ACTIVE_FILE: join(dir, 'a.json'), COPY2_ACTIVE_MIN_EVENTS: '10', ...env }), {
  pairs: () => pairs,
  events: () => events,
  depthUsd: (k) => money[k] ?? null,
  now: () => clock,
  log: (l) => logs.push(l),
});

// Off (default): every pool, unchanged.
const off = mk({});
assert(!off.on && off.filter(keys).join() === keys.join(), 'COPY2_ACTIVE_MAX unset: every watched pool is followed (old behaviour)');

// No events yet, no saved list: ranked by money (pair D then C), whole pairs.
const p1 = mk({ COPY2_ACTIVE_MAX: '3' });
const r1 = p1.filter(keys);
assert(r1.join() === '0xc1,0xc2,0xd1,0xd2' && p1.last?.from === 'money', `no events yet: busiest-by-money pairs, whole pairs (got ${r1.join()})`);
assert(!existsSync(join(dir, 'a.json')), 'a money ranking is not saved');

// Events: pair A busy (but per-pair cap 2), B second; X (no pair) never.
events = new Map([['0xa1', 50], ['0xa2', 30], ['0xa3', 1], ['0xb1', 20], ['0xb2', 5], ['0xx1', 999]]);
const p2 = mk({ COPY2_ACTIVE_MAX: '3', COPY2_ACTIVE_PER_PAIR: '2' });
const r2 = p2.filter(keys);
assert(r2.join() === '0xa1,0xa2,0xb1,0xb2' && p2.last?.from === 'events', `events: busiest pairs first, per-pair cap, no lone pools (got ${r2.join()})`);
assert(existsSync(join(dir, 'a.json')), 'an events ranking is saved for the next start');

// Cached until the refresh time; then worked out again.
events = new Map([['0xc1', 100], ['0xc2', 100]]);
assert(p2.filter(keys).join() === r2.join(), 'between refreshes the same list is kept (no churn)');
clock += 301_000;
assert(p2.filter(keys).join() === '0xc1,0xc2', `after the refresh time the list follows the new busy pairs (got ${p2.filter(keys).join()})`);

// Restart with few events: the saved list wins over money.
events = new Map();
const p3 = mk({ COPY2_ACTIVE_MAX: '3' });
const r3 = p3.filter(keys);
assert(p3.last?.from === 'saved list' && r3.includes('0xc1') && !r3.includes('0xd1'), `after a restart the saved list is used (got ${r3.join()})`);

// Saved list older than a day: ignored (money again).
clock += 25 * 3_600_000;
const p4 = mk({ COPY2_ACTIVE_MAX: '3' });
p4.filter(keys);
assert(p4.last?.from === 'money', 'a saved list older than 24 h is ignored');

// A failing dependency never breaks copy 2: every pool.
const bad = new Copy2ActivePicker(copy2ActiveSettings({ COPY2_ACTIVE_MAX: '3' }), { pairs: () => { throw new Error('boom'); }, events: () => events, depthUsd: () => null, log: () => {} });
assert(bad.filter(keys).join() === keys.join(), 'an error in the pick falls back to every pool');

// PUSH FEED ONLY COPY 2'S POOLS (COPY2_FEED_ACTIVE_ONLY).
const inner = { apply: (p: readonly string[], i: Iterable<string>) => ({ pools: [...p], ids: [...i] }) };
const all = ['0xa1', '0xb1', '0xc1'], ids = ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)];
let c2 = new Set<string>(['0xb1', '0x' + '2'.repeat(64)]);
assert(feedActiveOnly(inner, () => c2, true, false) === inner, 'COPY2_FEED_ACTIVE_ONLY off: the push filter is unchanged');
assert(feedActiveOnly(inner, () => c2, false, true) === inner, 'COPY2_ACTIVE_MAX off: the switch does nothing');
const f = feedActiveOnly(inner, () => c2, true, true);
const r = f.apply(all, ids);
assert(r.pools.join() === '0xb1' && r.ids.join() === '0x' + '2'.repeat(64), 'on: only the pools / ids copy 2 follows are subscribed');
c2 = new Set();
assert(f.apply(all, ids).pools.length === 3, 'copy 2 list empty (just started): full list');
c2 = new Set(['0x' + '2'.repeat(64)]);
assert(f.apply(all, ids).pools.length === 3, 'no contract left: full list (never an empty subscription)');
const boom = feedActiveOnly(inner, () => { throw new Error('x'); }, true, true);
assert(boom.apply(all, ids).pools.length === 3, 'an error: full list');
