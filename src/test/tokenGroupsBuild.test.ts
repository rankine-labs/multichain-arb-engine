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
  assert(logs2.some((l) => /^\[groups\] building: \d+ named coin\(s\) with USDG\/WETH pools/.test(l)), 'pricing step is logged');
  const saved2 = JSON.parse(readFileSync(symbolCacheFile, 'utf8'));
  assert(saved2.upTo === state.tokens.length, 'step marked finished once all names are read');
  assert(Array.isArray(res.members) && existsSync(outFile), 'list built and saved');

  // Run 3: nothing new on chain -> no names read at all.
  const asked3: string[] = [];
  await buildTokenGroups({ callMany: async (calls) => { if (calls[0]?.data === SEL_SYMBOL) asked3.push(...calls.map((c) => c.target)); return calls.map(() => null); }, state, pools, usdg: USDG, weth: WETH, symbolCacheFile, outFile, pauseMs: 0 });
  assert(asked3.length === 0, 'rebuild with no new coins reads no names');

  await realisticChain();
})();

// ---------------------------------------------------------------------------
// A realistic chain: 1,000 same-name junk coins must not swamp the build.
// Live, "2+ coins with the same name" made ~400,000 candidates and the full
// price read of all of them never finished. The cheap depth check (one
// USDG/WETH balance read per pool) must drop them before the full read.
// ---------------------------------------------------------------------------
async function realisticChain() {
  const SEL_DECIMALS = '0x313ce567', SEL_BALANCE = '0x70a08231', SEL_RESERVES = '0x0902f1ac';
  const word = (x: bigint) => x.toString(16).padStart(64, '0');
  const e = (n: number, d: number) => BigInt(Math.round(n * 1e6)) * 10n ** BigInt(d) / 1_000_000n;

  // Coins: [address, symbol, decimals]
  const usdg = A(1), weth = A(2), usdt = A(3), fakeUsdt = A(4), bAapl = A(5), aaplX = A(6);
  const junk = Array.from({ length: 1000 }, (_, i) => A(1000 + i));
  const sym = new Map<string, string>([[usdg, 'USDG'], [weth, 'WETH'], [usdt, 'USDT'], [fakeUsdt, 'USDT'], [bAapl, 'bAAPL'], [aaplX, 'AAPLx'], ...junk.map((j) => [j, 'PEPE'] as [string, string])]);
  const dec = new Map<string, number>([[usdg, 6], [weth, 18], [usdt, 6], [fakeUsdt, 6], [bAapl, 18], [aaplX, 18], ...junk.map((j) => [j, 18] as [string, number])]);

  // Pools (v2): token0, token1, human amounts. WETH = $3,000.
  type P = { pool: string; t0: string; t1: string; a0: number; a1: number };
  const ps: P[] = [
    { pool: A(0x9001), t0: weth, t1: usdg, a0: 100, a1: 300_000 },          // WETH $3,000
    { pool: A(0x9002), t0: usdt, t1: usdg, a0: 50_000, a1: 50_000 },        // real USDT, $100k
    { pool: A(0x9003), t0: fakeUsdt, t1: usdg, a0: 450, a1: 450 },          // lookalike, $900
    { pool: A(0x9004), t0: bAapl, t1: usdg, a0: 100, a1: 20_000 },          // bAAPL $200, $40k
    { pool: A(0x9005), t0: aaplX, t1: weth, a0: 150, a1: 10 },              // AAPLx $200 via WETH, $60k
    ...junk.map((j, i) => ({ pool: A(0xa0000 + i), t0: j, t1: weth, a0: 1_000_000, a1: 0.05 })), // $150 each
  ];
  const byPool = new Map(ps.map((p) => [p.pool, p]));
  const bal = (token: string, pool: string) => {
    const p = byPool.get(pool); if (!p) return 0n;
    return token === p.t0 ? e(p.a0, dec.get(p.t0)!) : token === p.t1 ? e(p.a1, dec.get(p.t1)!) : 0n;
  };

  const tokens = [...sym.keys()];
  const idx = new Map(tokens.map((t, i) => [t, i]));
  const st: ScanState = { version: 1, lastBlock: {}, factories: ['uniswap-v2|v2|' + A(9)], tokens, pools: ps.map((p) => [0, p.pool, idx.get(p.t0)!, idx.get(p.t1)!] as [number, string, number, number]) };
  const scanned: ScannedPool[] = ps.map((p) => ({ dex: 'uniswap-v2', kind: 'v2', pool: p.pool, token0: p.t0, token1: p.t1 } as unknown as ScannedPool));

  const reservesAsked = new Set<string>();
  const chain = async (calls: { target: string; data: string }[]) => calls.map((c) => {
    const sel = c.data.slice(0, 10);
    if (sel === SEL_SYMBOL) return encStr(sym.get(c.target) ?? '');
    if (sel === SEL_DECIMALS) return '0x' + word(BigInt(dec.get(c.target) ?? 18));
    if (sel === SEL_BALANCE) return '0x' + word(bal(c.target, '0x' + c.data.slice(-40)));
    if (sel === SEL_RESERVES) {
      reservesAsked.add(c.target);
      const p = byPool.get(c.target)!; return '0x' + word(e(p.a0, dec.get(p.t0)!)) + word(e(p.a1, dec.get(p.t1)!)) + word(0n);
    }
    return null;
  });

  const dir = mkdtempSync(join(tmpdir(), 'groups2-'));
  const logs: string[] = [];
  const r = await buildTokenGroups({ callMany: chain, state: st, pools: scanned, usdg, weth, symbolCacheFile: join(dir, 's.json'), outFile: join(dir, 'g.json'), pauseMs: 0, depthSlice: 300, log: (m) => logs.push(m) });
  const has = (t: string) => r.members.some((m) => m.token === t);

  assert(has(usdt) && has(usdg) && has(weth), 'real USDT verified alongside USDG and WETH');
  assert(!has(fakeUsdt) && r.rejected.some((x) => x.token === fakeUsdt && /only \$\d+ in its best pool/.test(x.why)), 'lookalike USDT ($900 pool) rejected with its pool size');
  assert(has(bAapl) && has(aaplX) && r.members.filter((m) => m.group === 'Copies of AAPL').length === 2, 'two real AAPL copies (one via a WETH pool) verified as a group');
  const aapl = r.members.find((m) => m.token === aaplX);
  assert(!!aapl && Math.abs(aapl.priceUsd - 200) < 0.5, `AAPLx priced through WETH at ~$200 (got ${aapl?.priceUsd})`);
  assert(junk.every((j) => !has(j)), 'none of the 1,000 same-name junk coins verified');
  assert(!r.rejected.some((x) => junk.includes(x.token)), 'junk coins leave no notes in the rejected list');
  assert(junk.every((_, i) => !reservesAsked.has(A(0xa0000 + i))), 'junk pools never get the full price read (cheap check dropped them)');
  assert(reservesAsked.size <= 5, `full price read only for the few real pools (${reservesAsked.size})`);
  assert(logs.some((l) => /pool\(s\) checked, \d+ deep enough; \d+ candidate coin\(s\), pricing \d+ pool\(s\)/.test(l)), 'depth check result is logged');

  // The cheap check is an upper bound: a pool right at the minimum still
  // passes it and is judged in full (here: $900 minimum, the $900 pool).
  const r2 = await buildTokenGroups({ callMany: chain, state: st, pools: scanned, usdg, weth, symbolCacheFile: join(dir, 's.json'), outFile: join(dir, 'g2.json'), pauseMs: 0, minDepthUsd: 900 });
  assert(r2.members.some((m) => m.token === fakeUsdt), 'pool exactly at the minimum passes the cheap check and is judged in full');
}
