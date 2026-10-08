// Tests for the coin-group build's progress and restart safety
// (buildTokenGroups in core/tokenGroups.ts).
//
// Why: on the live chain the coin-name step reads thousands of names on the
// gentle scan lane. It used to log nothing until the very end, and kept the
// names only in memory, so a restart threw the work away. Now it logs
// progress every few bundles and saves the names read so far.
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTokenGroups } from '../core/tokenGroups';
import type { ScanState, ScannedPool } from '../core/universeScan';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const SEL_SYMBOL = '0x95d89b41';

// ABI-encoded string return value, as symbol() gives it.
const encStr = (s: string) => {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex.padEnd(64, '0');
};

// A fake chain: USDG, WETH and 1,000 coins, each with one pool against WETH.
const USDG = A(1), WETH = A(2);
const N = 1000;
const coins = Array.from({ length: N }, (_, i) => A(100 + i));
const state: ScanState = {
  version: 1, lastBlock: {}, factories: ['uniswap-v2|v2|' + A(9)],
  tokens: [USDG, WETH, ...coins],
  pools: coins.map((_, i) => [0, A(5000 + i), 1, 2 + i] as [number, string, number, number]),
};
const pools: ScannedPool[] = coins.map((c, i) => ({ dex: 'uniswap-v2', kind: 'v2', pool: A(5000 + i), token0: WETH, token1: c } as unknown as ScannedPool));

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'groups-'));
  const symbolCacheFile = join(dir, 'symbols.json');
  const outFile = join(dir, 'token-groups.json');

  // Run 1: the node fails on the 3rd bundle of names (like a restart mid-way).
  let symbolBundles = 0;
  const symbolsAsked: string[] = [];
  const failing = async (calls: { target: string; data: string }[]) => {
    if (calls[0]?.data === SEL_SYMBOL) {
      if (++symbolBundles === 3) throw new Error('node went away');
      symbolsAsked.push(...calls.map((c) => c.target));
      return calls.map(() => encStr('JUNK'));
    }
    return calls.map(() => null);
  };
  const logs1: string[] = [];
  let threw = false;
  try {
    await buildTokenGroups({ callMany: failing, state, pools, usdg: USDG, weth: WETH, symbolCacheFile, outFile, pauseMs: 0, progressEvery: 1, log: (m) => logs1.push(m) });
  } catch { threw = true; }
  assert(threw, 'a node failure mid-way still surfaces as an error (caller retries later)');
  assert(logs1.some((l) => /^\[groups\] building: reading 1000 coin name\(s\)/.test(l)), 'start line says how many names will be read');
  assert(logs1.some((l) => /^\[groups\] building: coin names 400 of 1000 read/.test(l)), 'progress line after the first bundle');
  assert(logs1.some((l) => /^\[groups\] building: coin names 800 of 1000 read/.test(l)), 'progress line after the second bundle');
  assert(existsSync(symbolCacheFile), 'names read so far were saved before the failure');
  const saved = JSON.parse(readFileSync(symbolCacheFile, 'utf8'));
  assert(Object.keys(saved.symbols).length === 800 && saved.upTo === 0, 'saved: 800 names, step not marked finished');

  // Run 2: resumes. Only the 200 names not read yet are asked for.
  const asked2: string[] = [];
  const ok = async (calls: { target: string; data: string }[]) => {
    if (calls[0]?.data === SEL_SYMBOL) { asked2.push(...calls.map((c) => c.target)); return calls.map(() => encStr('JUNK')); }
    return calls.map(() => null);
  };
  const logs2: string[] = [];
  const res = await buildTokenGroups({ callMany: ok, state, pools, usdg: USDG, weth: WETH, symbolCacheFile, outFile, pauseMs: 0, progressEvery: 1, log: (m) => logs2.push(m) });
  assert(asked2.length === 200, `resume reads only the 200 missing names (read ${asked2.length})`);
  assert(!asked2.some((t) => symbolsAsked.includes(t)), 'no name is read twice');
  assert(logs2.some((l) => /^\[groups\] symbols: 200 new read, 1000 known/.test(l)), 'finish line counts the full list');
  assert(logs2.some((l) => /^\[groups\] building: pricing /.test(l)), 'pricing step is logged');
  const saved2 = JSON.parse(readFileSync(symbolCacheFile, 'utf8'));
  assert(saved2.upTo === state.tokens.length, 'step marked finished once all names are read');
  assert(Array.isArray(res.members) && existsSync(outFile), 'list built and saved');

  // Run 3: nothing new on chain -> no names read at all.
  const asked3: string[] = [];
  await buildTokenGroups({ callMany: async (calls) => { if (calls[0]?.data === SEL_SYMBOL) asked3.push(...calls.map((c) => c.target)); return calls.map(() => null); }, state, pools, usdg: USDG, weth: WETH, symbolCacheFile, outFile, pauseMs: 0 });
  assert(asked3.length === 0, 'rebuild with no new coins reads no names');
})();
