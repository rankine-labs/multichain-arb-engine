// Oct 26: the loop list asks for coin tax tests of its middle coins.
// Allowed coins only, never USDG / WETH, never a coin with a fresh pass, each once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askLoopTaxTests } from '../execution/trigEntryLoops';

type P = { a: string; b: string; h: string | null };
const USDG = '0x' + '1'.repeat(40), WETH = '0x' + '2'.repeat(40);
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), BAD = '0x' + 'd'.repeat(40), TAXED = '0x' + 'e'.repeat(40);
const r = { tokens: (p: P) => [p.a, p.b] as [string, string], holder: (p: P) => p.h, allowed: (t: string) => t !== BAD };

test('asks for untested allowed middle coins once, skips start coins, passes, bad and unallowed coins', () => {
  const verdicts: Record<string, string> = { [B]: 'ok', [TAXED]: 'taxed' };
  const asked: Array<[string, string]> = [];
  const book = { verdict: (t: string) => verdicts[t], request: (t: string, h: string) => { asked.push([t, h]); } };
  const pools: P[] = [
    { a: USDG, b: A, h: '0xpool1' },
    { a: A, b: WETH, h: '0xpool2' },      // A again: asked once only
    { a: B, b: WETH, h: '0xpool3' },      // B has a fresh pass
    { a: BAD, b: USDG, h: '0xpool4' },    // not on the allowed list
    { a: C, b: WETH, h: null },           // no holder known: skipped
    { a: TAXED, b: WETH, h: '0xpool6' },  // known bad: the book decides re-tests itself (asked, it filters)
  ];
  const n = askLoopTaxTests(pools, r, [USDG, WETH], book);
  assert.deepEqual(asked.map((x) => x[0]), [A, TAXED]);
  assert.equal(asked[0][1], '0xpool1');
  assert.equal(n, 2);
});

test('a throwing pool is skipped, the rest still asked', () => {
  const asked: string[] = [];
  const book = { verdict: () => undefined, request: (t: string) => { asked.push(t); } };
  const bad = { tokens: (p: P) => { if (p.a === C) throw new Error('x'); return [p.a, p.b] as [string, string]; }, holder: (p: P) => p.h, allowed: () => true };
  askLoopTaxTests([{ a: C, b: WETH, h: '0x1' }, { a: A, b: USDG, h: '0x2' }], bad, [USDG, WETH], book);
  assert.deepEqual(asked, [A]);
});
