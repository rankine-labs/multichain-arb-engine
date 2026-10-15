// Tests for the Oct 15 freeze fix (REBUILD_PACED): the 6-hourly / startup
// rebuilds now take short breaks and write their read requests by hand.
//
// What is checked (plain English):
//   1. Pacer: the name given after a break now really covers the work that
//      follows (before, the name ended before that work even started, so it
//      showed up as "other (during ...)" in the freeze report).
//   2. Hand-written read requests and the hand name reader give exactly what
//      ethers gives (many random samples, plus odd ones that go to ethers).
//   3. The scan's pricing / ranking / "add new pools" steps give the same
//      answers in bites as in one go.
//   4. The whole chain-wide scan on a fake node: same result, same saved
//      state and byte-for-byte the same requests sent, with and without
//      REBUILD_PACED.
//   5. The coin names file: read in bites = JSON.parse, written in pieces =
//      JSON.stringify(..., null, 1), odd files go to the old reader; and the
//      coin groups build gives the same list and the same file bytes.
//   6. Cross-quote and loop monitor setups pick the same tokens in bites.
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ethers } from 'ethers';
import { Pacer, drainSteps, runSteps } from '../core/chunked';
import { stallFinder } from '../core/stallFinder';
import {
  encodeBalanceOf, fastDecodeString, CALL_DECIMALS, CALL_SYMBOL, CALL_STABLE,
  derivePrices, derivePricesSteps, rankCandidates, rankCandidatesSteps,
  addPoolsToState, addPoolsToStateSteps, buildScanStateIndexSteps, scanUniverse,
  ScanState, ScannedPool, ScanFactory,
} from '../core/universeScan';
import { buildTokenGroups, parseSymbolCacheSteps, symbolCachePieces, loadSymbolCacheMap } from '../core/tokenGroups';
import { CrossQuoteMonitor, LoopMonitor } from '../core/crossQuoteMonitor';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
// Deep equality for plain data (Maps, Sets and bigints included).
const norm = (v: unknown): unknown => {
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Map) return ['Map', [...v.entries()].map(([k, x]) => [norm(k), norm(x)])];
  if (v instanceof Set) return ['Set', [...v].map(norm)];
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
};
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
// Small repeatable random numbers (same every run).
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const pairI = new ethers.Interface(['function stable() view returns (bool)']);
const mc3 = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const word = (x: bigint) => x.toString(16).padStart(64, '0');

async function main() {
  // ===========================================================================
  // 1) Pacer names the work after a break
  // ===========================================================================
  {
    const named: number[] = [];
    const orig = stallFinder.noteSlice.bind(stallFinder);
    stallFinder.noteSlice = (name: string, s: number, e: number, self?: number) => { if (name === 'pacer test') named.push(e - s); return orig(name, s, e, self); };
    const spin = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) { /* busy */ } };
    const p = new Pacer('pacer test', 1, true);
    for (let i = 0; i < 2048; i++) { if (p.due()) await p.rest(); spin(0.005); }
    spin(20); // a long step after the last break (like reading a file)
    await new Promise((r) => setImmediate(r));
    stallFinder.noteSlice = orig;
    const longest = Math.max(0, ...named);
    assert(named.length >= 2 && named.slice(0, -1).every((ms) => ms >= 0.5), `stretches between breaks are named (${named.length}, ${named.slice(0, 3).map((x) => x.toFixed(1)).join('/')} ms)`);
    assert(longest >= 20, `a long step after the last break is named too (${longest.toFixed(1)} ms)`);
  }

  // ===========================================================================
  // 2) Hand-written requests and name reader = ethers
  // ===========================================================================
  {
    let ok = true;
    for (let i = 0; i < 300; i++) {
      const raw = '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
      for (const a of [raw, ethers.getAddress(raw), '0x' + raw.slice(2).toUpperCase()]) {
        let want: string; try { want = erc20.encodeFunctionData('balanceOf', [a]); } catch { want = 'throws'; }
        let got: string; try { got = encodeBalanceOf(a); } catch { got = 'throws'; }
        // ethers rejects a mixed-case address with a wrong checksum; the scan never has one (see universeScan.ts)
        if (want !== got && !(want === 'throws' && a !== a.toLowerCase() && a !== '0x' + a.slice(2).toUpperCase())) ok = false;
      }
    }
    assert(ok, 'balanceOf request written by hand = ethers (lower, checksummed, upper case)');
    let bad1 = 'none', bad2 = 'none';
    try { encodeBalanceOf('0x1234'); } catch { bad1 = 'throws'; }
    try { erc20.encodeFunctionData('balanceOf', ['0x1234']); } catch { bad2 = 'throws'; }
    assert(bad1 === bad2 && bad1 === 'throws', 'a bad address still goes to ethers (and is still refused)');
    assert(CALL_DECIMALS === erc20.encodeFunctionData('decimals') && CALL_SYMBOL === erc20.encodeFunctionData('symbol') && CALL_STABLE === pairI.encodeFunctionData('stable'), 'fixed requests (decimals, symbol, stable) = ethers');

    // The scan's rule: hand reader if it can, else ethers, else the short address.
    const viaScan = (r: string | null) => { const f = fastDecodeString(r); if (f !== null) return f; try { return String(erc20.decodeFunctionResult('symbol', r!)[0]); } catch { return 'FALLBACK'; } };
    const viaEthers = (r: string | null) => { try { return String(erc20.decodeFunctionResult('symbol', r!)[0]); } catch { return 'FALLBACK'; } };
    const samples: (string | null)[] = [null, '0x', '0x00', '0xzz', word(1n), '0x' + word(32n), '0x' + word(32n) + word(3n), '0x' + word(32n) + word(3n) + 'abc'];
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcxyz0123456789 .-_"\\\u0000\u007f';
    for (let i = 0; i < 400; i++) {
      const len = Math.floor(rnd() * 70);
      let str = Array.from({ length: len }, () => chars[Math.floor(rnd() * chars.length)]).join('');
      if (i % 7 === 0) str += '₮é'; // not plain ASCII: ethers must handle it
      const good = erc20.encodeFunctionResult('symbol', [str]);
      samples.push(good);
      samples.push(good.slice(0, good.length - 2 * (1 + Math.floor(rnd() * 40)))); // cut short
      samples.push(good + 'ab');                                                // extra byte at the end
      samples.push(good.slice(0, 66) + word(BigInt(len + 40)) + good.slice(130)); // length too long
      samples.push('0x' + word(64n) + good.slice(66));                          // unusual offset
    }
    // A bytes32-style symbol (old tokens) and invalid UTF-8.
    samples.push('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0'));
    samples.push('0x' + word(32n) + word(2n) + 'c328'.padEnd(64, '0'));
    const mismatch = samples.filter((r) => viaScan(r) !== viaEthers(r));
    assert(mismatch.length === 0, `hand name reader = ethers on ${samples.length} answers (good, short, long, odd, non-ASCII)`);
    assert(fastDecodeString(erc20.encodeFunctionResult('symbol', ['USDG'])) === 'USDG', 'plain name read by hand');
  }

  // ===========================================================================
  // 3) Pricing, ranking and "add new pools": same in bites as in one go
  // ===========================================================================
  const USDG = A(0xa1), WETH = A(0xa2);
  {
    const pools: ScannedPool[] = [];
    const dec = new Map<string, number>([[USDG, 6], [WETH, 18]]);
    pools.push({ dex: 'uniswap-v2', kind: 'v2', pool: A(0x5000), token0: WETH, token1: USDG, bal0: 100n * 10n ** 18n, bal1: 300_000n * 10n ** 6n });
    for (let i = 0; i < 3000; i++) {
      const t = A(0x1000 + (i % 1200)); dec.set(t, 18);
      const q = i % 3 === 0 ? USDG : WETH;
      pools.push({ dex: ['uniswap-v2', 'uniswap-v3', 'ramses-v2'][i % 3], kind: (['v2', 'v3', 'solidly'] as const)[i % 3], pool: A(0x6000 + i), token0: t, token1: q,
        bal0: BigInt(Math.floor(rnd() * 1e6)) * 10n ** 18n, bal1: BigInt(Math.floor(rnd() * 1e5)) * (q === USDG ? 10n ** 6n : 10n ** 15n), stable: i % 11 === 0 });
    }
    const p1 = derivePrices(pools, dec, USDG, WETH);
    const p2 = await runSteps(derivePricesSteps(pools, dec, USDG, WETH), 'test', 0);
    assert(p1.size > 100 && same(p1, p2), `prices in bites = in one go (${p1.size} coins priced)`);
    for (const p of pools) p.usd = Math.floor(rnd() * 10_000);
    const r1 = rankCandidates(pools, 2_000), r2 = await runSteps(rankCandidatesSteps(pools, 2_000), 'test', 0);
    assert(r1.candidates.length > 10 && same(r1, r2), `ranking in bites = in one go (${r1.candidates.length} pairs)`);

    // New pools added to a saved scan.
    const mk = (): ScanState => ({ version: 1, lastBlock: {}, tokens: [USDG, WETH, A(0x1000).toLowerCase()], pools: [[0, ethers.getAddress(A(0x7000)), 2, 1]], factories: ['uniswap-v2|v2|' + A(9)] });
    const fA: ScanFactory = { dex: 'uniswap-v2', kind: 'v2', factory: A(9) };
    const fB: ScanFactory = { dex: 'sushi-v3', kind: 'v3', factory: ethers.getAddress(A(0xabcdef)) };
    const batch1: ScannedPool[] = [
      { dex: 'uniswap-v2', kind: 'v2', pool: A(0x7000).toUpperCase().replace('0X', '0x'), token0: A(0x1000), token1: WETH },  // already known (other case)
      { dex: 'uniswap-v2', kind: 'v2', pool: ethers.getAddress(A(0x7001)), token0: ethers.getAddress(A(0x1001)), token1: WETH },
      { dex: 'uniswap-v2', kind: 'v2', pool: ethers.getAddress(A(0x7001)), token0: ethers.getAddress(A(0x1001)), token1: WETH }, // same pool twice in one list
    ];
    const batch2: ScannedPool[] = [
      { dex: 'sushi-v3', kind: 'v3', pool: ethers.getAddress(A(0x7002)), token0: A(0x1002), token1: USDG },
      { dex: 'sushi-v3', kind: 'v3', pool: ethers.getAddress(A(0x7001)), token0: A(0x1001), token1: WETH }, // known from batch 1
    ];
    const s1 = mk(), s2 = mk();
    addPoolsToState(s1, fA, batch1); addPoolsToState(s1, fB, batch2); addPoolsToState(s1, fA, []);
    const idx = drainSteps(buildScanStateIndexSteps(s2));
    drainSteps(addPoolsToStateSteps(s2, fA, batch1, idx)); drainSteps(addPoolsToStateSteps(s2, fB, batch2, idx));
    // (The old code adds a pool listed twice in one batch twice; the new code keeps that.)
    assert(same(s1, s2) && s1.pools.length === 4 && s1.tokens.length === 5, `new pools added the same way with the kept lookups (${s1.pools.length} pools, ${s1.tokens.length} coins)`);
  }

  // ===========================================================================
  // 4) Whole scan on a fake node: same result, state and requests
  // ===========================================================================
  {
    const chain = (() => {
      const pools: { f: number; pool: string; t0: string; t1: string }[] = [];
      pools.push({ f: 0, pool: ethers.getAddress(A(0x8000)), t0: WETH, t1: USDG });
      for (let i = 0; i < 400; i++) {
        const t = ethers.getAddress(A(0x2000 + i));
        const q = i % 4 === 0 ? USDG : WETH;
        pools.push({ f: i % 3, pool: ethers.getAddress(A(0x9000 + i * 3)), t0: t, t1: q });
        if (i % 2 === 0) pools.push({ f: (i + 1) % 3, pool: ethers.getAddress(A(0x9001 + i * 3)), t0: t, t1: q });    // 2nd pool: a pair to watch
        if (i % 5 === 0) pools.push({ f: (i + 2) % 3, pool: ethers.getAddress(A(0x9002 + i * 3)), t0: t, t1: q === USDG ? WETH : USDG });
      }
      return pools;
    })();
    const factories: ScanFactory[] = [
      { dex: 'uniswap-v2', kind: 'v2', factory: ethers.getAddress(A(0xf1)) },
      { dex: 'ramses-v2', kind: 'solidly', factory: ethers.getAddress(A(0xf2)) },
      { dex: 'uniswap-v3', kind: 'v3', factory: ethers.getAddress(A(0xf3)) },
    ];
    const names = ['HOOD', 'TSLA', 'Ünïcode', 'MEME', ''];
    // The node: logs for pools created after block 100; answers by hash.
    const makeProvider = (sent: string[]) => ({
      getCode: async () => '0x01',
      getBlockNumber: async () => 200,
      send: async (_m: string, params: any[]) => {
        const fi = factories.findIndex((f) => f.factory.toLowerCase() === String(params[0].address).toLowerCase());
        return chain.filter((p, i) => p.f === fi && i % 7 === 3).map((p) => ({
          topics: ['0x' + '1'.repeat(64), '0x' + '0'.repeat(24) + p.t0.slice(2).toLowerCase(), '0x' + '0'.repeat(24) + p.t1.slice(2).toLowerCase()],
          data: (fi === 1 ? '0x' + word(0n) : '0x') + '0'.repeat(24) + p.pool.slice(2).toLowerCase(),
        }));
      },
      call: async ({ data }: { to: string; data: string }) => {
        sent.push(data);
        const calls = mc3.decodeFunctionData('aggregate3', data)[0] as any[];
        const out = calls.map((c: any) => {
          const target = String(c[0]).toLowerCase(), cd = String(c[2]);
          const h = parseInt(ethers.id(target + cd).slice(2, 10), 16);
          if (cd === CALL_DECIMALS) return [true, '0x' + word(target === USDG ? 6n : 18n)];
          if (cd === CALL_SYMBOL) return [true, erc20.encodeFunctionResult('symbol', [names[h % names.length]])];
          if (cd === CALL_STABLE) return [true, '0x' + word(BigInt(h % 2))];
          if (cd.startsWith('0x70a08231')) {
            const unit = target === USDG ? 10n ** 6n : 10n ** 18n;
            const big = target === USDG || target === WETH ? 50_000n : 1_000_000n;
            return [true, '0x' + word(BigInt(h % 1000) * big * unit / 100n)];
          }
          return [false, '0x'];
        });
        return mc3.encodeFunctionResult('aggregate3', [out]);
      },
    });
    const run = async (paced: boolean) => {
      const sent: string[] = [];
      const state: ScanState = { version: 1, lastBlock: Object.fromEntries(factories.map((f) => [f.factory.toLowerCase(), 100])), tokens: [], pools: [], factories: [] };
      // The saved part: pools created up to block 100 (every pool not served as a log).
      const t = (x: string) => { const k = x.toLowerCase(); let i = state.tokens.indexOf(k); if (i < 0) i = state.tokens.push(k) - 1; return i; };
      for (let f = 0; f < 3; f++) state.factories.push(`${factories[f].dex}|${factories[f].kind}|${factories[f].factory.toLowerCase()}`);
      chain.forEach((p, i) => { if (i % 7 !== 3) state.pools.push([p.f, p.pool, t(p.t0), t(p.t1)]); });
      const res = await scanUniverse(makeProvider(sent) as any, factories, { usdToken: USDG, wrappedNative: WETH, minPoolUsd: 2_000, chunked: true, paced, paceMs: 0 }, state);
      return { res, state, sent };
    };
    const a = await run(false), b = await run(true);
    assert(a.res.candidates.length > 5 && a.res.errors.length === 0, `fake chain scan finds pairs (${a.res.candidates.length}, ${a.res.totalPools} pools)`);
    assert(same(a.res, b.res), 'scan result the same with REBUILD_PACED (pairs, coins, names, prices)');
    assert(same(a.state, b.state), 'saved scan state the same (new pools added the same way)');
    assert(a.sent.length > 3 && same(a.sent, b.sent), `requests sent byte for byte the same (${a.sent.length} bundles)`);
    assert([...b.res.tokens.values()].some((x) => x.symbol === 'Ünïcode') && [...b.res.tokens.values()].some((x) => x.symbol === 'HOOD'), 'non-ASCII names still read (by ethers), plain ones by hand');
  }

  // ===========================================================================
  // 5) Coin names file and the coin groups build
  // ===========================================================================
  {
    const cases: Record<string, string>[] = [{}, { [A(1)]: 'USDT' }];
    const big: Record<string, string> = {};
    const chars = 'ABCxyz019 "\\/\n\t\u0000₮é😀,:{}';
    for (let i = 0; i < 5000; i++) big[A(0x100000 + i)] = Array.from({ length: Math.floor(rnd() * 12) }, () => chars[Math.floor(rnd() * chars.length)]).join('');
    cases.push(big);
    let ok = true;
    for (const symbols of cases) {
      const obj = { upTo: 77, symbols };
      const text = JSON.stringify(obj, null, 1);
      const parsed = drainSteps(parseSymbolCacheSteps(text));
      if (!parsed || parsed.upTo !== 77 || !same([...parsed.symbols.entries()], Object.entries(symbols))) ok = false;
      if (parsed && [...symbolCachePieces(parsed)].join('') !== text) ok = false;
    }
    assert(ok, 'names file: read in bites = JSON.parse, written in pieces = JSON.stringify(.., null, 1) (incl. quotes, escapes, emoji, empty)');
    const odd = [
      JSON.stringify({ upTo: 1, symbols: { [A(1)]: 'X' } }),                          // no indent
      JSON.stringify({ upTo: 1, symbols: { [A(1)]: 'X' } }, null, 1) + '\n',          // trailing newline
      JSON.stringify({ upTo: 1, symbols: { [A(1)]: 'X' }, extra: 1 }, null, 1),        // extra field
      JSON.stringify({ symbols: { [A(1)]: 'X' }, upTo: 1 }, null, 1),                 // other order
      JSON.stringify({ upTo: 1, symbols: { '123': 'X', [A(1)]: 'Y' } }, null, 1),      // number-like key
      JSON.stringify({ upTo: 1, symbols: { [A(1)]: 5 } }, null, 1),                   // not a name
      JSON.stringify({ upTo: '1', symbols: {} }, null, 1),
      '{\n "upTo": 1,\n "symbols": {\n  "a": "1",\n  "a": "2"\n }\n}',                 // same key twice
      'not json',
    ];
    assert(odd.every((t) => drainSteps(parseSymbolCacheSteps(t)) === null), 'odd names files are left to the old one-go reader');
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
    const m0 = await loadSymbolCacheMap(join(dir, 'missing.json'));
    assert(!!m0 && m0.upTo === 0 && m0.symbols.size === 0, 'no names file yet: empty list (like before)');
    writeFileSync(join(dir, 'odd.json'), odd[0]);
    assert((await loadSymbolCacheMap(join(dir, 'odd.json'))) === null, 'odd names file: old code path is used');

    // The coin groups build: same list and the same names file, with
    // progress saves along the way (some names known, some read).
    const SEL_SYMBOL = '0x95d89b41', SEL_DECIMALS = '0x313ce567', SEL_BALANCE = '0x70a08231', SEL_RESERVES = '0x0902f1ac';
    const encStr = (s: string) => erc20.encodeFunctionResult('symbol', [s]);
    const usdg = A(1), weth = A(2);
    const nm = ['USDT', 'USDC', 'WBTC', 'cbBTC', 'PEPE', 'TSLAx', 'bTSLA', 'DOGE', 'Ünï'];
    const N = 3000;
    const coins = Array.from({ length: N }, (_, i) => A(1000 + i));
    const sym = new Map<string, string>(coins.map((c, i) => [c, nm[i % nm.length]]));
    type P = { pool: string; t0: string; t1: string; a0: bigint; a1: bigint };
    const ps: P[] = [{ pool: A(0x900000), t0: weth, t1: usdg, a0: 100n * 10n ** 18n, a1: 300_000n * 10n ** 6n }];
    coins.forEach((c, i) => {
      const q = i % 2 ? usdg : weth, deep = i % 37 === 0;
      ps.push({ pool: A(0x910000 + i), t0: c, t1: q, a0: 10_000n * 10n ** 18n, a1: q === usdg ? (deep ? 50_000n : 100n) * 10n ** 6n : (deep ? 20n : 1n) * 10n ** 16n });
    });
    const byPool = new Map(ps.map((p) => [p.pool.toLowerCase(), p]));
    const callMany = async (calls: { target: string; data: string }[]) => calls.map((c) => {
      const t = c.target.toLowerCase();
      if (c.data === SEL_SYMBOL) return encStr(sym.get(t) ?? 'X');
      if (c.data === SEL_DECIMALS) return '0x' + word(t === usdg ? 6n : 18n);
      if (c.data.startsWith(SEL_BALANCE)) { const p = byPool.get('0x' + c.data.slice(-40)); return '0x' + word(!p ? 0n : t === p.t0 ? p.a0 : t === p.t1 ? p.a1 : 0n); }
      if (c.data === SEL_RESERVES) { const p = byPool.get(t); return p ? '0x' + word(p.a0) + word(p.a1) + word(0n) : null; }
      return null;
    });
    const state = { version: 1, lastBlock: {}, factories: [], tokens: [usdg, weth, ...coins], pools: [] } as unknown as ScanState;
    const pools = ps.map((p) => ({ dex: 'uniswap-v2', kind: 'v2', pool: p.pool, token0: p.t0, token1: p.t1 } as unknown as ScannedPool));
    // Start from a names file that already knows the first 1,000 coins.
    const known: Record<string, string> = {};
    coins.slice(0, 1000).forEach((c) => { known[c] = sym.get(c)!; });
    const startFile = JSON.stringify({ upTo: 1002, symbols: known }, null, 1);
    const runB = async (rebuildPaced: boolean) => {
      const d = mkdtempSync(join(tmpdir(), 'groups3-'));
      writeFileSync(join(d, 's.json'), startFile);
      const logs: string[] = [];
      const r = await buildTokenGroups({ callMany, state, pools, usdg, weth, symbolCacheFile: join(d, 's.json'), outFile: join(d, 'g.json'), pauseMs: 0, progressEvery: 1, paced: true, paceMs: 0, rebuildPaced, log: (m) => logs.push(m.replace(/\(\d+s\)/g, '')) });
      return { r: { members: r.members, rejected: r.rejected }, file: readFileSync(join(d, 's.json'), 'utf8'), logs };
    };
    const a = await runB(false), b = await runB(true);
    assert(a.r.members.length > 2, `coin groups test chain builds a list (${a.r.members.length} verified)`);
    assert(same(a.r, b.r), 'coin groups: same list with REBUILD_PACED');
    assert(a.file === b.file && a.file.length > 1000, 'coin groups: names file byte for byte the same');
    assert(same(a.logs, b.logs), 'coin groups: same progress lines (counts included)');
  }

  // ===========================================================================
  // 6) Cross-quote and loop monitor setups pick the same tokens in bites
  // ===========================================================================
  {
    const usdg = A(0xa1), weth = A(0xa2), usdt = A(0xa3);
    const scanned: ScannedPool[] = [
      { dex: 'uniswap-v2', kind: 'v2', pool: A(0xe000), token0: weth, token1: usdg },
      { dex: 'uniswap-v3', kind: 'v3', pool: A(0xe001), token0: usdt, token1: usdg },
      { dex: 'uniswap-v2', kind: 'v2', pool: A(0xe002), token0: usdt, token1: weth },
    ];
    for (let i = 0; i < 4000; i++) {
      const t = A(0x3000 + (i % 1500));
      const q = [usdg, weth, usdt][Math.floor(i / 1500) % 3]; // each coin gets pools against different quotes
      scanned.push({ dex: ['uniswap-v2', 'uniswap-v3', 'pancakeswap-v2'][i % 3], kind: i % 3 === 1 ? 'v3' : 'v2', pool: A(0xf000 + i), token0: t, token1: q, stable: i % 17 === 0 });
    }
    const callMany = async (calls: { target: string; data: string }[]) => calls.map((c) => {
      const h = parseInt(ethers.id(c.target.toLowerCase() + c.data).slice(2, 10), 16);
      if (c.data === '0x313ce567') return '0x' + word(c.target === usdg || c.target === usdt ? 6n : 18n);
      if (c.data === '0x95d89b41') return erc20.encodeFunctionResult('symbol', ['T' + (h % 100)]);
      return '0x' + word(BigInt(h % 5000) * 10n ** (c.target === usdg || c.target === usdt ? 6n : 15n));
    });
    const legsOf = (m: unknown) => norm({ legs: (m as any).legs, convs: (m as any).convs, dec: (m as any).decimals, sym: (m as any).symbols });
    const cq = async (paced: boolean) => { const m = new CrossQuoteMonitor(callMany, usdg, weth, () => 3000, () => 1); const n = await m.setup(scanned, 60, undefined, { paced, paceMs: 0 }); return { n, s: legsOf(m) }; };
    const c1 = await cq(false), c2 = await cq(true);
    assert(c1.n > 5 && same(c1, c2), `cross-quote setup: same tokens in bites (${c1.n})`);
    const quotes = [{ token: usdg, symbol: 'USDG', group: 'Dollars', priceUsd: 1 }, { token: usdt, symbol: 'USDT', group: 'Dollars', priceUsd: 1 }, { token: weth, symbol: 'WETH', group: 'ETH', priceUsd: 3000 }];
    const lm = async (paced: boolean) => { const m = new LoopMonitor(callMany, () => 1); const n = await m.setup(scanned, quotes, 80, undefined, { paced, paceMs: 0 }); return { n, s: legsOf(m) }; };
    const l1 = await lm(false), l2 = await lm(true);
    assert(l1.n > 5 && same(l1, l2), `loop monitor setup: same tokens in bites (${l1.n})`);
  }
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
