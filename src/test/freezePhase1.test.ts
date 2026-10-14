// Tests for the Oct 14 "freeze phase 1" changes (no trading decision changes):
//   1. Stall finder: work after an await is named (mark / labelled); GC is
//      matched to freezes even when thousands of clean-ups happen in between;
//      the freeze count is exact past the list size; memory made per second.
//   2. Pool cache indexes give exactly the same answers as the full walk.
//   3. Price oracle: same prices with the index and the middle-price memory.
//   4. Fast gap scan == old gap scan on thousands of random inputs (with
//      pools changing between scans), and it really pauses between pairs.
//   5. Thin pool check in steps == one go; cross-quote watch in bites == one go.
//   6. Block reader address sets: a frozen list is reused, any other rebuilt.
//   7. Status page reads the [mem] and [stalls] lines.
// No timing upper bounds (the server runs these during deploys).
import { StallFinder, formatStallLine, formatStallDetail, MAX_STALLS, labelled, stallFinder } from '../core/stallFinder';
import { PoolCache } from '../core/poolCache';
import { PriceOracle, registerStablecoin } from '../core/priceOracle';
import { findStandingGaps, findStandingGapsSteps, GapScanMemo, StandingGap, GapOptions } from '../core/gapScanner';
import { drainSteps, runSteps } from '../core/chunked';
import { setRealBalanceSource, thinPools, thinPoolsSteps } from '../core/poolPrice';
import { CrossQuoteMonitor } from '../core/crossQuoteMonitor';
import { AddressSetCache } from '../core/blockReader';
import { PoolState } from '../core/types';
import { join } from 'path';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
// Hold the thread for `ms` (what a heavy job does).
const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };

// Small seeded random numbers so every run tests the same cases.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const hex40 = (n: number) => '0x' + n.toString(16).padStart(40, '0');

async function main() {
  // ===========================================================================
  // 1) Stall finder
  // ===========================================================================
  {
    // Work after an await, named with mark(): its time is recorded under that name.
    const f = new StallFinder({ enabled: true });
    await (async () => { await Promise.resolve(); f.mark('after the wait'); busy(30); })();
    await new Promise((r) => setImmediate(r));
    const s = f.take('fiveMin');
    const j = s.longest.find((x) => x.name === 'after the wait');
    assert(!!j && j.maxMs >= 29, `mark(): work after an await is named (${j ? Math.round(j.maxMs) : 'none'} ms)`);

    // A freeze inside a marked stretch is blamed on it, not "other".
    const g = new StallFinder({ enabled: true });
    let t0 = 0, t1 = 0;
    await (async () => { await Promise.resolve(); g.mark('feed trade'); t0 = performance.now(); busy(60); t1 = performance.now(); })();
    await new Promise((r) => setImmediate(r));
    g.recordStall(t0, t1, t1 - t0);
    const gs = g.take('fiveMin');
    assert(gs.causes[0]?.name === 'feed trade' && !gs.causes.some((c) => c.name.startsWith('other')), `freeze after an await blamed on "feed trade" (${gs.causes.map((c) => c.name).join(', ')})`);

    // labelled(): a wrapped callback is timed under its name (global finder).
    stallFinder.take('fiveMin');
    const cb = labelled('test timer', (x: number) => { busy(12); return x * 2; });
    const out = cb(21);
    const ls = stallFinder.take('fiveMin');
    assert(out === 42 && ls.longest.some((x) => x.name === 'test timer' && x.maxMs >= 11), 'labelled(): callback timed under its name, return value passed through');

    // GC reported AFTER the freeze, with 3,000 more clean-ups in between
    // (the old code lost the match once 1,000 newer clean-ups arrived).
    const h = new StallFinder({ enabled: true });
    const t = performance.now() + 1_000;
    h.recordStall(t, t + 100, 90);
    h.noteGc(t + 5, 80, 'major');
    for (let i = 0; i < 3_000; i++) h.noteGc(t + 1_000 + i * 10, 2, 'minor');
    // GC reported BEFORE the freeze is noticed (other order).
    h.noteGc(t + 50_000, 70, 'major');
    h.recordStall(t + 49_990, t + 50_080, 80);
    const hs = h.take('hour', t + 100_000);
    const gc = hs.causes.find((c) => c.name === 'GC');
    assert(!!gc && gc.n === 2 && !hs.causes.some((c) => c.name.startsWith('other')), `GC matched both ways, even after 3,000 newer clean-ups (${hs.causes.map((c) => `${c.name} ${c.n}x`).join(', ')})`);

    // Exact freeze count past the list size, causes "from the newest N".
    const k = new StallFinder({ enabled: true });
    const kt = performance.now() + 1_000;
    const N = MAX_STALLS + 1_000;
    for (let i = 0; i < N; i++) k.recordStall(kt + i, kt + i + 0.5, 60);
    const ks = k.take('hour', kt + N + 10);
    const line = formatStallLine(ks);
    assert(ks.freezes === N, `freeze count is exact past the list size (${ks.freezes} of ${N})`);
    assert(ks.causesFrom !== undefined && ks.causesFrom < N && line.includes(`top causes (newest ${ks.causesFrom})`), `line says causes come from the newest freezes: ${line.slice(0, 90)}`);

    // Memory made per second: heap growth between readings, drops ignored.
    const heaps = [100, 150, 140, 240, 50, 60].map((m) => m * 1_048_576);
    const a = new StallFinder({ enabled: true });
    for (const hb of heaps) a.noteHeap(500, hb);  // 6 readings, 0.5 s apart = 3 s
    const as = a.take('fiveMin');
    // Growth: +50, +100, +10 = 160 MB over 3 s.
    assert(as.allocMbPerSec !== undefined && Math.abs(as.allocMbPerSec - 160 / 3) < 1e-6, `memory made per second: ${as.allocMbPerSec?.toFixed(1)} MB/s (expected 53.3)`);
    const detail = formatStallDetail({ ...as, allocMbPerSec: 53.3 });
    assert(detail.includes('memory made: at least 53 MB/s') && !/—/.test(detail), `detail line shows memory made: ${detail}`);
  }

  // ===========================================================================
  // 2) Pool cache indexes == full walk
  // ===========================================================================
  {
    const on = new PoolCache({ index: true }), off = new PoolCache({ index: false });
    const tokens = Array.from({ length: 12 }, (_, i) => hex40(0x1000 + i));
    const caseOf = (s: string) => (rnd() < 0.5 ? s.toUpperCase().replace('0X', '0x') : s);
    const chains = ['robinhood', 'monad'] as const;
    let mismatches = 0, checks = 0;
    const mk = (i: number): PoolState => {
      const a = pick(tokens); let b = pick(tokens); while (b === a) b = pick(tokens);
      return { chain: pick([...chains]), dex: 'uniswap-v2', poolAddress: caseOf(hex40(0x9000 + i)), poolType: 'v2', tokenA: caseOf(a), tokenB: caseOf(b),
        reserveA: BigInt(Math.floor(rnd() * 1e6)), reserveB: BigInt(Math.floor(rnd() * 1e6)), feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: Math.floor(rnd() * 10_000) };
    };
    const known: PoolState[] = [];
    for (let step = 0; step < 3_000; step++) {
      const r = rnd();
      if (r < 0.45 || !known.length) { const p = mk(known.length); known.push(p); on.upsert(p); off.upsert(p); }
      else if (r < 0.75) { const p = { ...pick(known), reserveA: BigInt(Math.floor(rnd() * 1e6)) }; on.upsertFromFeed(p, 5_000); off.upsertFromFeed(p, 5_000); }
      else if (r < 0.85) { const p = { ...pick(known) }; on.upsertFromBlock(p, 6_000); off.upsertFromBlock(p, 6_000); }
      else if (r < 0.95) { const p = { ...pick(known), lastUpdatedMs: 7_000 }; on.upsertIfNotNewer(p, 1, 9_000); off.upsertIfNotNewer(p, 1, 9_000); }
      else { const cut = rnd(); on.prune((p) => p.reserveA! % 7n !== 0n, 3_000 * cut, 9_000); off.prune((p) => p.reserveA! % 7n !== 0n, 3_000 * cut, 9_000); }
      if (step % 10 === 0) {
        const c = pick([...chains]);
        const a = caseOf(pick(tokens)), b = caseOf(pick(tokens));
        const ex = rnd() < 0.5 ? '' : caseOf(pick(known).poolAddress);
        const sig = (p: PoolState) => `${p.poolAddress}|${p.reserveA}|${p.reserveB}|${p.lastUpdatedMs}`;
        const same = (x: PoolState[], y: PoolState[]) => x.length === y.length && x.every((p, i) => sig(p) === sig(y[i]));
        checks += 4;
        if (!same(on.findPeerPools(c, a, b, ex), off.findPeerPools(c, a, b, ex))) mismatches++;
        if (!same(on.allForChain(c), off.allForChain(c))) mismatches++;
        if (!same(on.withToken(c, a), off.withToken(c, a))) mismatches++;
        if (!same([...on.forChain(c)], off.allForChain(c))) mismatches++;
      }
    }
    assert(mismatches === 0 && checks > 1_000, `pool index answers == full walk (${checks} checks, ${mismatches} different)`);
    assert(on.size() === off.size(), 'same pool count after prunes');
  }

  // ===========================================================================
  // 3) Price oracle: same prices with the index + middle-price memory
  // ===========================================================================
  {
    const USD = hex40(0xaaaa), ETH = hex40(0xbbbb);
    registerStablecoin('robinhood', USD);
    const coins = Array.from({ length: 30 }, (_, i) => hex40(0x2000 + i));
    const build = (index: boolean) => new PoolCache({ index });
    const ci = build(true), cf = build(false);
    let n = 0;
    const v2 = (a: string, b: string, ra: number, rb: number): PoolState => ({ chain: 'robinhood', dex: 'uniswap-v2', poolAddress: hex40(0x7000 + n++), poolType: 'v2', tokenA: a, tokenB: b,
      reserveA: BigInt(Math.round(ra * 1e18)), reserveB: BigInt(Math.round(rb * 1e18)), feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: 0 });
    const pools: PoolState[] = [v2(ETH, USD, 1_000, 4_000_000), v2(ETH, USD, 10, 41_000)];
    for (const c of coins) {
      pools.push(v2(c, ETH, 1_000 + rnd() * 1e5, 10 + rnd() * 100));
      if (rnd() < 0.4) pools.push(v2(c, USD, 1_000 + rnd() * 1e5, 10_000 + rnd() * 1e5));
    }
    for (const p of pools) { ci.upsert(p); cf.upsert(p); }
    const memoOn = new PriceOracle(ci, () => 18, 1_000, () => 0);   // memory on, clock never moves
    const plain = new PriceOracle(cf, () => 18, 0, () => 0);        // no memory, full walk
    let diff = 0;
    for (const c of [...coins, ETH, USD]) {
      const x = memoOn.getUsdPriceInfo('robinhood', c), y = plain.getUsdPriceInfo('robinhood', c);
      if (JSON.stringify(x) !== JSON.stringify(y)) diff++;
    }
    assert(diff === 0, `oracle prices identical: index + middle-price memory vs full walk without memory (${coins.length + 2} coins)`);
  }

  // ===========================================================================
  // 4) Fast gap scan == old gap scan (random, with changes between scans)
  // ===========================================================================
  {
    const Q = hex40(0xeeee); // quote coin (6 decimals, $1)
    const bases = Array.from({ length: 40 }, (_, i) => hex40(0x3000 + i));
    const decimals = new Map<string, number>([[Q, 6]]);
    for (const b of bases) decimals.set(b, 18);
    const usd = new Map<string, number | null>([[Q, 1]]);
    const decOf = (t: string) => decimals.get(t.toLowerCase());
    const usdOf = (t: string) => usd.get(t.toLowerCase()) ?? null;
    // Real balances for V3 pools (the "real balance cap"), changed between scans.
    const bal = new Map<string, bigint>();
    setRealBalanceSource((p, t) => bal.get(`${p.toLowerCase()}:${t.toLowerCase()}`));
    let pn = 0;
    const mkPool = (base: string, price: number): PoolState => {
      const addr = hex40(0x5000 + pn++);
      const baseIsA = rnd() < 0.5;
      const fee = pick([30, 5, 100, 25]);
      if (rnd() < 0.5) {
        const rBase = 1_000 + rnd() * 50_000, rQuote = rBase * price * (1 + (rnd() - 0.5) * 0.06);
        const ra = baseIsA ? BigInt(Math.round(rBase * 1e18)) : BigInt(Math.round(rQuote * 1e6));
        const rb = baseIsA ? BigInt(Math.round(rQuote * 1e6)) : BigInt(Math.round(rBase * 1e18));
        return { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: addr, poolType: 'v2', tokenA: baseIsA ? base : Q, tokenB: baseIsA ? Q : base, reserveA: ra, reserveB: rb, feeBps: fee, lastUpdatedBlock: 0, lastUpdatedMs: 0 };
      }
      // V3: price in raw units of tokenB per tokenA.
      const p = price * (1 + (rnd() - 0.5) * 0.06);
      const raw = baseIsA ? p * 1e6 / 1e18 : 1e18 / (p * 1e6);
      const sqrt = BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
      const pool: PoolState = { chain: 'robinhood', dex: 'uniswap-v3', poolAddress: addr, poolType: 'v3', tokenA: baseIsA ? base : Q, tokenB: baseIsA ? Q : base,
        sqrtPriceX96: sqrt, liquidity: BigInt(Math.floor(1e15 + rnd() * 1e18)), feeBps: fee, feePips: rnd() < 0.3 ? fee * 100 + 50 : undefined, lastUpdatedBlock: 0, lastUpdatedMs: 0 };
      if (rnd() < 0.5) bal.set(`${addr}:${base}`, BigInt(Math.floor(rnd() * 1e22)));
      if (rnd() < 0.5) bal.set(`${addr}:${Q}`, BigInt(Math.floor(rnd() * 1e11)));
      return pool;
    };
    let pairs: PoolState[][] = bases.map((b) => {
      const price = 1 + rnd() * 300;
      usd.set(b, rnd() < 0.2 ? price : null);
      return Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => mkPool(b, price));
    });
    // Odd cases: a pair with an order-book pool, a lone pool, unknown decimals, a duplicate pair.
    pairs.push([{ ...pairs[0][0], poolType: 'orderbook', poolAddress: hex40(0x6001) }, pairs[1][0]]);
    pairs.push([pairs[2][0]]);
    decimals.delete(bases[3]);
    pairs.push([...pairs[4]]);

    const sameGaps = (x: StandingGap[], y: StandingGap[]) => x.length === y.length && x.every((g, i) => {
      const h = y[i];
      return g.pairKey === h.pairKey && g.base === h.base && g.quote === h.quote && g.buyPool === h.buyPool && g.sellPool === h.sellPool
        && g.sizeQuote === h.sizeQuote && g.sizeUsd === h.sizeUsd && g.profitUsd === h.profitUsd && g.quoteUsd === h.quoteUsd;
    });
    const memo = new GapScanMemo();
    let opts: GapOptions = { minProfitUsd: 0.1, flashFee: 0.0005, gasUsd: 0.05, maxTradeUsd: 50_000, perPair: 3 };
    let diff = 0, scans = 0, totalGaps = 0;
    for (let round = 0; round < 300; round++) {
      // Changes between scans, like blocks moving a few pools.
      for (let c = 0; c < 4; c++) {
        const pi = Math.floor(rnd() * bases.length), pair = pairs[pi];
        const k = Math.floor(rnd() * pair.length), p = pair[k];
        const r = rnd();
        if (r < 0.35 && p.poolType === 'v2') pair[k] = { ...p, reserveB: p.reserveB! + BigInt(Math.floor(rnd() * 1e9)) };
        else if (r < 0.5 && p.poolType === 'v3') pair[k] = { ...p, sqrtPriceX96: p.sqrtPriceX96! + BigInt(Math.floor(rnd() * 1e20)) };
        else if (r < 0.6) pair[k] = { ...p };                                  // new object, same numbers
        else if (r < 0.7) pair[k] = { ...p, feePips: pick([undefined, 2500, 3000, 500]) };
        else if (r < 0.8) bal.set(`${p.poolAddress}:${Q}`, BigInt(Math.floor(rnd() * 1e11)));
        else if (r < 0.88) usd.set(pick(bases), rnd() < 0.5 ? null : 1 + rnd() * 300);
        else if (r < 0.93) pairs = [...pairs].reverse();                      // order of pairs changes
        else if (r < 0.96) pair.reverse();                                    // order of pools changes
        else (p as any).feePips = pick([100, 3000]);                          // changed in place (same object)
      }
      if (round % 60 === 59) opts = { ...opts, minProfitUsd: pick([0.1, 0.5, 2]), perPair: pick([1, 3]) };
      const old = findStandingGaps(pairs, decOf, usdOf, opts);
      const fast = drainSteps(findStandingGapsSteps(pairs, decOf, usdOf, opts, memo));
      scans++; totalGaps += old.length;
      if (!sameGaps(old, fast)) diff++;
    }
    assert(diff === 0 && totalGaps > 50, `fast gap scan == old scan on ${scans} random scans with changes (${totalGaps} gaps, ${diff} different)`);
    assert(memo.reused > memo.worked, `fast scan reuses unchanged pairs (reused ${memo.reused}, worked out ${memo.worked})`);

    // It really pauses: with 0 ms bites, a timer set before the scan runs before it ends.
    let ranBetween = false;
    setImmediate(() => { ranBetween = true; });
    const chunked = await runSteps(findStandingGapsSteps(pairs, decOf, usdOf, opts, new GapScanMemo()), 'gap scan test', 0);
    assert(ranBetween && sameGaps(chunked, findStandingGaps(pairs, decOf, usdOf, opts)), 'gap scan in bites: pauses between pairs and gives the same gaps');

    // Thin pool check in steps == one go (same real balances as above).
    const all = pairs.flat();
    const dl = (_c: string, t: string) => decOf(t) ?? 18;
    const one = thinPools(all, dl, usdOf, 60_000), steps = drainSteps(thinPoolsSteps(all, dl, usdOf, 60_000));
    assert(one.length > 0 && one.length === steps.length && one.every((x, i) => x.pool === steps[i].pool && x.realUsd === steps[i].realUsd && x.virtualUsd === steps[i].virtualUsd), `thin pool check in steps == one go (${one.length} thin pools)`);
    setRealBalanceSource(null); // leave no global state behind
  }

  // ===========================================================================
  // 5) Cross-quote watch: in bites == one go
  // ===========================================================================
  {
    const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
    const w = (v: bigint) => v.toString(16).padStart(64, '0');
    const toks = Array.from({ length: 25 }, (_, i) => hex40(0x100 + i));   // sorts below both quotes -> token0
    const scanned = toks.flatMap((t, i) => [
      { dex: 'uniswap-v2', kind: 'v2' as const, pool: hex40(0x4000 + i * 2), token0: t, token1: USDG },
      { dex: 'uniswap-v2', kind: 'v2' as const, pool: hex40(0x4001 + i * 2), token0: t, token1: WETH },
    ]);
    const reserves = new Map<string, [bigint, bigint]>();
    for (const s of scanned) reserves.set(s.pool, s.token1 === USDG ? [1_000n * 10n ** 18n, BigInt(150_000 + Math.floor(rnd() * 100_000)) * 10n ** 6n] : [1_000n * 10n ** 18n, BigInt(40 + Math.floor(rnd() * 30)) * 10n ** 18n]);
    const callMany = async (calls: { target: string; data: string }[]) => calls.map((c) => {
      const sel = c.data.slice(0, 10);
      if (sel === '0x70a08231') return '0x' + w(100_000n * 10n ** 18n);
      if (sel === '0x313ce567') return '0x' + w(18n);
      if (sel === '0x95d89b41') return '0x' + w(32n) + w(3n) + Buffer.from('TOK').toString('hex').padEnd(64, '0');
      if (sel === '0x0902f1ac') { const r = reserves.get(c.target.toLowerCase()); return r ? '0x' + w(r[0]) + w(r[1]) + w(0n) : null; }
      return null;
    });
    let clock = 0;
    const a = new CrossQuoteMonitor(callMany, USDG, WETH, () => 4_000, () => clock);
    const b = new CrossQuoteMonitor(callMany, USDG, WETH, () => 4_000, () => clock);
    const na = await a.setup(scanned), nb = await b.setup(scanned);
    for (let i = 0; i < 6; i++) {
      for (const [k, r] of reserves) if (rnd() < 0.3) reserves.set(k, [r[0], r[1] + BigInt(Math.floor(rnd() * 5)) * 10n ** 17n]);
      await a.tick(i % 2 === 0, '2026-10-14');
      await b.tickChunked(i % 2 === 0, '2026-10-14');
      clock += 15_000;
    }
    const ja = JSON.stringify(a.rows()), jb = JSON.stringify(b.rows());
    if (ja !== jb) console.log('one go:', ja.slice(0, 400), '\nbites: ', jb.slice(0, 400));
    assert(na === 25 && nb === 25 && ja === jb && a.rows().length >= 15, `cross-quote watch in bites == one go (${a.rows().length} tokens measured, 6 ticks)`);
  }

  // ===========================================================================
  // 6) Block reader address sets
  // ===========================================================================
  {
    const c = new AddressSetCache();
    const frozen = Object.freeze(['0xAA', '0xbb']);
    const s1 = c.get(frozen, '0xpm'), s2 = c.get(frozen, '0xpm');
    assert(s1 === s2 && s1.has('0xaa') && s1.has('0xpm') && s1.size === 3, 'frozen list: set built once, reused, lower-cased, PoolManager added');
    const plain = ['0xcc'];
    const p1 = c.get(plain, '');
    plain.push('0xDD');
    const p2 = c.get(plain, '');
    assert(p1 !== p2 && p2.has('0xdd') && !p1.has('0xdd'), 'ordinary (changeable) list: rebuilt every time, so changes are seen');
    assert(c.get(frozen, '') !== s1 && !c.get(frozen, '').has('0xpm'), 'different PoolManager: rebuilt');
  }

  // ===========================================================================
  // 7) Status page: [mem] and [stalls] lines
  // ===========================================================================
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const status = require(join(__dirname, '..', '..', 'deploy', 'status-report.js'));
    const lines = [
      '[mem] rss 900 MB · heap used 240 / total 610 / limit 4144 MB · external 35 MB · buffers 12 MB · peak rss 1010 MB, peak heap used 260 MB · sizes: pools 4000, opportunities 1200',
      '[mem] pruned 12 idle pools (cache 4000, opportunity log 1200, heap 250 MB)',
      '[stalls] Freezes over 50 ms: 2000 (worst 1503 ms) · top causes: other 1515x (max 955 ms)',
      '[stalls] Memory clean-up (GC): 158355x, 363.0 s in total, worst 249 ms (major), 364 major · memory made: at least 400 MB/s',
      '[mem] rss 950 MB · heap used 250 / total 620 / limit 4144 MB · external 35 MB · buffers 12 MB · peak rss 1010 MB, peak heap used 260 MB · sizes: pools 4100',
    ];
    const m = status.memSummary(lines);
    assert(m === 'rss 950 MB (peak 1010) · real data (heap used) 250 of 620 MB, limit 4144 MB · sizes: pools 4100', `status page memory line: ${m}`);
    const s = status.stallSummary(lines);
    assert(s.startsWith('Freezes over 50 ms: 2000 (worst 1503 ms)') && s.includes('Memory clean-up (GC): 158355x') && s.includes('at least 400 MB/s'), `status page freeze line: ${s.slice(0, 80)}...`);
    assert(status.memSummary([]) === null && status.stallSummary(['[gap] x']) === null, 'no lines yet: nothing shown');
  }
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
