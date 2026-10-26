// Oct 26: the loop index counts WHY pools were left out (for the hourly line).
// Checks the counts with and without the optional *Why helpers, and the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLoopIndexSteps, LoopRules, loopSkipText } from '../execution/trigEntryLoops';

type P = { k: string; a: string; b: string; dex: string; depth: number };
const USDG = '0x' + '1'.repeat(40), WETH = '0x' + '2'.repeat(40), X = '0x' + '3'.repeat(40), BAD = '0x' + '4'.repeat(40);
const drain = <T>(g: Generator<void, T, void>): T => { for (;;) { const r = g.next(); if (r.done) return r.value; } };
const pools: P[] = [
  { k: 'p1', a: USDG, b: X, dex: 'ok', depth: 5 },
  { k: 'p2', a: X, b: WETH, dex: 'ok', depth: 5 },
  { k: 'p3', a: WETH, b: USDG, dex: 'ok', depth: 5 },
  { k: 'p4', a: USDG, b: BAD, dex: 'ok', depth: 5 },      // bad coin
  { k: 'p5', a: USDG, b: X, dex: 'blocked-dex', depth: 5 }, // pool rule
  { k: 'p6', a: X, b: WETH, dex: 'ok', depth: 0 },         // too shallow
  { k: 'p1', a: USDG, b: X, dex: 'ok', depth: 5 },         // duplicate: not counted twice
];
const base = { key: (p: P) => p.k, tokens: (p: P) => [p.a, p.b] as [string, string], depth: (p: P) => p.depth };
const opts = { perPool: 50, maxLoops: 1000 };

test('without reason helpers: plain labels, usable pools unchanged', () => {
  const r: LoopRules<P> = { ...base, poolOk: (p) => p.dex !== 'blocked-dex' && p.depth > 0, coinOk: (t) => t !== BAD };
  const d = drain(buildLoopIndexSteps(pools, [USDG, WETH], r, opts));
  assert.equal(d.pools, 3);
  assert.equal(d.seen, 6);
  assert.deepEqual(d.skipped, { 'middle coin not allowed': 1, 'pool rule': 2 });
  assert.ok(d.loops > 0);
});

test('with reason helpers: the helpers decide and name the reason', () => {
  const r: LoopRules<P> = {
    ...base, poolOk: () => true, coinOk: () => true, // ignored when the helpers are given
    poolWhy: (p) => (p.dex === 'blocked-dex' ? 'live rule: exchange not cleared' : p.depth <= 0 ? 'too shallow' : null),
    coinWhy: (t) => (t === BAD ? 'coin not on allowlist' : null),
  };
  const d = drain(buildLoopIndexSteps(pools, [USDG, WETH], r, opts));
  assert.equal(d.pools, 3);
  assert.deepEqual(d.skipped, { 'coin not on allowlist': 1, 'live rule: exchange not cleared': 1, 'too shallow': 1 });
});

test('hourly text: biggest first, rest grouped', () => {
  assert.equal(loopSkipText(10, {}), '10 pools offered, none left out');
  assert.equal(loopSkipText(100, { a: 1, b: 50, c: 9 }, 2), '100 pools offered, left out: b 50, c 9, other 1');
});
