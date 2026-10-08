// Tests for loop measurement Phase A: verified coin groups (core/tokenGroups.ts),
// the loop monitor (LoopMonitor in core/crossQuoteMonitor.ts) and the LOOP REPORT.
import { classifySymbol, copyKey, pickCandidates, verifyGroups, quotePools, decodeSymbol, groupsStatusLine, QuotePrice } from '../core/tokenGroups';
import { LoopMonitor, bestLoop, isBrokenLoop, PricedLeg, LoopLegInfo } from '../core/crossQuoteMonitor';
import { formatLoopReport, loopVerdict } from '../core/telegramFormatter';
import type { PoolState } from '../core/types';
import type { ScannedPool } from '../core/universeScan';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');

// ---------------------------------------------------------------------------
// 1) Groups: names make candidates, money and price make them verified.
// ---------------------------------------------------------------------------
assert(classifySymbol('USDT')?.group === 'Dollars' && classifySymbol('USDC.e')?.group === 'Dollars' && classifySymbol('PYUSD')?.group === 'Dollars', 'dollar coins recognised by name');
assert(classifySymbol('WETH')?.group === 'ETH' && classifySymbol('wstETH') === null && classifySymbol('stETH') === null, 'WETH is ETH; staked ETH skipped');
assert(classifySymbol('WBTC')?.group === 'Bitcoin' && classifySymbol('cbBTC')?.group === 'Bitcoin', 'Bitcoin versions recognised');
assert(classifySymbol('HOOD') === null, 'ordinary token is not in a fixed group');
assert(copyKey('bAAPL') === 'AAPL' && copyKey('AAPLx') === 'AAPL' && copyKey('AAPL.e') === 'AAPL' && copyKey('AAPL') === 'AAPL', 'copies share a core name');
const cands = pickCandidates([
  { token: A(1), symbol: 'USDT' }, { token: A(2), symbol: 'USDT' },      // real + lookalike
  { token: A(3), symbol: 'WBTC' }, { token: A(4), symbol: 'cbBTC' },
  { token: A(5), symbol: 'AAPL' }, { token: A(6), symbol: 'AAPLx' },
  { token: A(7), symbol: 'HOOD' },                                        // one of a kind: not a candidate
]);
assert(cands.length === 6 && !cands.some((c) => c.symbol === 'HOOD') && cands.filter((c) => c.group === 'Copies of AAPL').length === 2, 'candidates: fixed groups + copies with 2+ members');

const USDG = A(0xa), WETH = A(0xb);
const prices = new Map<string, QuotePrice>([
  [A(1), { priceUsd: 0.999, depthUsd: 500_000, pool: A(0x101) }],     // real USDT
  [A(2), { priceUsd: 1.0, depthUsd: 900, pool: A(0x102) }],           // lookalike USDT: tiny pool
  [A(3), { priceUsd: 60_000, depthUsd: 200_000, pool: A(0x103) }],
  [A(4), { priceUsd: 59_500, depthUsd: 50_000, pool: A(0x104) }],     // 0.8% off WBTC: fine
  [A(5), { priceUsd: 250, depthUsd: 80_000, pool: A(0x105) }],
  [A(6), { priceUsd: 240, depthUsd: 30_000, pool: A(0x106) }],        // 4% off: rejected
]);
const v = verifyGroups(cands, prices, { usdg: USDG, weth: WETH, wethUsd: 2_000 });
const vs = (t: string) => v.members.find((m) => m.token === t);
assert(!!vs(A(1)) && !vs(A(2)), 'real USDT verified, lookalike with a $900 pool rejected (names never trusted)');
assert(!!vs(A(3)) && !!vs(A(4)) && near(vs(A(4))!.offPct, (1 - 59_500 / 60_000) * 100), 'Bitcoin group verified against its deepest member');
assert(!vs(A(5)) && !vs(A(6)), 'AAPL copies: one 4% off leaves a group of one, so neither is used');
assert(!!vs(USDG) && !!vs(WETH), 'USDG and WETH are always in (they are the yardsticks)');
assert(v.rejected.some((r) => r.token === A(2) && r.why.includes('$900')) && v.rejected.some((r) => r.token === A(6) && r.why.includes('4.0%')), 'rejections explain why');
assert(groupsStatusLine({ version: 1, updatedAt: 0, ...v }).includes('Bitcoin: WBTC'), 'status line lists verified coins by group');
// A coin claiming to be a dollar but priced at $0.90 is rejected.
const fake = verifyGroups([{ token: A(9), symbol: 'USDC', kind: 'dollar', group: 'Dollars' }], new Map([[A(9), { priceUsd: 0.9, depthUsd: 1e6, pool: '' }]]), { usdg: USDG, weth: WETH, wethUsd: 2000 });
assert(!fake.members.some((m) => m.token === A(9)), 'dollar-named coin at $0.90 is not a dollar');
const qp = quotePools([{ dex: 'x', kind: 'v2', pool: A(0x200), token0: A(1), token1: USDG }, { dex: 'x', kind: 'v2', pool: A(0x201), token0: A(7), token1: A(1) }], USDG, WETH);
assert(qp.has(A(1)) && !qp.has(A(7)), 'only pools against USDG/WETH are used for pricing');
const enc = (str: string) => '0x' + (32).toString(16).padStart(64, '0') + str.length.toString(16).padStart(64, '0') + Buffer.from(str).toString('hex').padEnd(64, '0');
assert(decodeSymbol(enc('USDT')) === 'USDT' && decodeSymbol('0x') === null, 'symbol decoding');

// ---------------------------------------------------------------------------
// 2) The best loop, by hand.
// ---------------------------------------------------------------------------
const leg = (quote: string, feePct: number, label: string, depthUsd = 100_000): LoopLegInfo => ({ quote, feePct, label, depthUsd, pool: { poolAddress: A(Math.floor(Math.random() * 1e9)) } as PoolState });
const USDT = A(1);
const legs: PricedLeg[] = [{ leg: leg(USDG, 0.3, 'uniswap-v2'), px: 100 }, { leg: leg(USDT, 0.25, 'pancakeswap-v2', 40_000), px: 102 }];
const conv = (a: string, b: string) => ({ a, b, px: 1, feePct: 0.3, pool: A(0xc0), depthUsd: 1e6, label: 'uniswap-v2' });
const order = USDG < USDT ? [USDG, USDT] : [USDT, USDG];
const sym = (t: string) => (t === USDG ? 'USDG' : t === USDT ? 'USDT' : '?');
const b = bestLoop(legs, (a, c) => (a === order[0] && c === order[1] ? conv(a, c) : null), sym, 'HOOD')!;
assert(near(b.gapPct, 2, 1e-9) && near(b.netPct, 2 - 0.85, 1e-9), 'HOOD $100 on USDG vs $102 on USDT: 2% gap, 1.15% after the 3 fees');
assert(b.route.startsWith('USDG → HOOD (uniswap-v2) → USDT (pancakeswap-v2) → USDG') && b.shallowUsd === 40_000, 'route names the cheap pool first and the shallowest pool');
// The conversion pool's REAL price counts: USDT worth only $0.98 kills the gap.
const b2 = bestLoop(legs, (a, c) => (a === order[0] && c === order[1] ? { ...conv(a, c), px: order[0] === USDG ? 0.98 : 1 / 0.98 } : null), sym, 'HOOD')!;
assert(b2.netPct < 0, 'USDT/USDG at 0.98: no loop left after fees');
assert(bestLoop(legs, () => null, sym, 'HOOD') === null, 'no pool between the two quotes: no loop');

// ---------------------------------------------------------------------------
// 3) The monitor on a fake chain.
// ---------------------------------------------------------------------------
const HOOD = A(0x11), JUNK = A(0x12), THIN = A(0x13), MEME = A(0x14), USDT2 = USDT;
const dec: Record<string, number> = { [USDG]: 6, [USDT2]: 6, [WETH]: 18, [HOOD]: 18, [JUNK]: 18, [THIN]: 18, [MEME]: 18 };
const symOf: Record<string, string> = { [USDG]: 'USDG', [USDT2]: 'USDT', [WETH]: 'WETH', [HOOD]: 'HOOD', [JUNK]: 'JUNK', [THIN]: 'THIN', [MEME]: 'MEME' };
type FakePool = { p: ScannedPool; r0: bigint; r1: bigint };
const E18 = 10n ** 18n, E6 = 10n ** 6n;
const pools: FakePool[] = [
  { p: { dex: 'uniswap-v2', kind: 'v2', pool: A(0x301), token0: HOOD, token1: USDG }, r0: 1_000n * E18, r1: 100_000n * E6 },
  { p: { dex: 'pancakeswap-v2', kind: 'v2', pool: A(0x302), token0: HOOD, token1: USDT2 }, r0: 1_000n * E18, r1: 102_000n * E6 },
  { p: { dex: 'uniswap-v2', kind: 'v2', pool: A(0x303), token0: USDT2, token1: USDG }, r0: 1_000_000n * E6, r1: 1_000_000n * E6 },
  { p: { dex: 'pancakeswap-v2', kind: 'v2', pool: A(0x304), token0: USDT2, token1: USDG }, r0: 1_000_000n * E6, r1: 1_004_000n * E6 },
  { p: { dex: 'uniswap-v2', kind: 'v2', pool: A(0x305), token0: JUNK, token1: USDG }, r0: 1_000n * E18, r1: 10_000n * E6 },
  { p: { dex: 'uniswap-v2', kind: 'v2', pool: A(0x306), token0: JUNK, token1: USDT2 }, r0: 1_000n * E18, r1: 13_800n * E6 },
  { p: { dex: 'uniswap-v2', kind: 'v2', pool: A(0x307), token0: THIN, token1: USDG }, r0: 1_000n * E18, r1: 50_000n * E6 },
  { p: { dex: 'uniswap-v2', kind: 'v2', pool: A(0x308), token0: THIN, token1: USDT2 }, r0: 1n * E18, r1: 50n * E6 },   // $50: too shallow
  { p: { dex: 'uniswap-v2', kind: 'v2', pool: A(0x309), token0: MEME, token1: WETH }, r0: 1_000n * E18, r1: 5n * E18 }, // one quote only
];
const word = (x: bigint) => x.toString(16).padStart(64, '0');
let reads = 0;
const fakeCallMany = async (calls: { target: string; data: string }[]) => {
  reads++;
  return calls.map(({ target, data }) => {
    const t = target.toLowerCase(), sel = data.slice(0, 10);
    if (sel === '0x313ce567') return dec[t] !== undefined ? '0x' + word(BigInt(dec[t])) : null;
    if (sel === '0x95d89b41') return symOf[t] ? enc(symOf[t]) : null;
    if (sel === '0xddca3f43') return null; // V2 pools have no fee() (reverts)
    const fp = pools.find((x) => x.p.pool.toLowerCase() === t);
    if (sel === '0x0902f1ac') return fp ? '0x' + word(fp.r0) + word(fp.r1) + word(0n) : null;
    if (sel === '0x70a08231') {
      const pool = '0x' + data.slice(34).toLowerCase();
      const q = pools.find((x) => x.p.pool.toLowerCase() === pool);
      if (!q) return '0x' + word(0n);
      return '0x' + word(q.p.token0.toLowerCase() === t ? q.r0 : q.p.token1.toLowerCase() === t ? q.r1 : 0n);
    }
    return null;
  });
};

async function main() {
  let clock = 1_000_000;
  // ETH vs WETH from the pool cache: a token 1% apart, both pools 0.05%.
  const nat = { tokenA: WETH, tokenB: HOOD, poolType: 'v2', reserveA: 10n * E18, reserveB: 1_000n * E18, feeBps: 5, poolAddress: A(0x401), v4: { native: true } } as unknown as PoolState;
  const wr = { tokenA: WETH, tokenB: HOOD, poolType: 'v2', reserveA: 101n * E18 / 10n, reserveB: 1_000n * E18, feeBps: 5, poolAddress: A(0x402) } as unknown as PoolState;
  const mon = new LoopMonitor(fakeCallMany, () => clock, () => [{ label: 'HOOD: ETH pool vs WETH pool', token: HOOD, native: nat, wrapped: wr }], (t) => dec[t.toLowerCase()]);
  const quotes = [
    { token: USDG, symbol: 'USDG', group: 'Dollars', priceUsd: 1 },
    { token: USDT2, symbol: 'USDT', group: 'Dollars', priceUsd: 1 },
    { token: WETH, symbol: 'WETH', group: 'ETH', priceUsd: 2_000 },
  ];
  const n = await mon.setup(pools.map((x) => x.p), quotes);
  assert(n >= 2 && mon.quoteCount() === 3, 'setup: HOOD and JUNK (and the dollar coins themselves) can loop');
  assert(!mon.rows().length, 'no stats before the first reading');
  reads = 0;
  for (let i = 0; i < 25; i++) { await mon.tick(); clock += 30_000; }
  assert(reads === 25, 'one bundled read per round');
  const rows = mon.rows();
  const hood = rows.find((r) => r.symbol === 'HOOD')!;
  // The loop closes through the DEEPEST USDT/USDG pool (PancakeSwap, 1.004 USDG
  // per USDT, 0.25% fee): (102 x 1.004 / 100 - 1) = 2.408% gap, minus
  // 0.3% + 0.25% + 0.25% fees = 1.608% after fees.
  const expNet = (1.02 * 1.004 - 1) * 100 - (0.3 + 0.25 + 0.25);
  assert(!!hood && near(hood.stats.maxNetPct, expNet, 1e-6), 'HOOD loop: gap after the three real fees, using the conversion pool\'s real price');
  assert(near(hood.stats.secondsProfitable, 24 * 30) && near(hood.stats.longestRunS, 24 * 30), 'time worth trading adds up across readings');
  assert(!!hood.stats.best && hood.stats.best.route.includes('USDG → HOOD'), 'best route recorded');
  const junk = rows.find((r) => r.symbol === 'JUNK')!;
  assert(junk.broken && isBrokenLoop(junk.stats), 'JUNK (38% gap all day) is marked broken');
  assert(!rows.some((r) => r.symbol === 'THIN' || r.symbol === 'MEME'), 'too-shallow and single-quote tokens are not watched');
  const pegs = mon.pegRows();
  const usdt = pegs.find((p) => p.label === 'USDT vs USDG' || p.label === 'USDG vs USDT')!;
  assert(!!usdt && near(usdt.stats.maxDevPct, 0.4, 1e-6) && usdt.stats.maxNetPct < 0, 'USDT/USDG: one pool 0.4% off 1:1, two pools apart less than the fees');
  const ew = pegs.find((p) => p.group === 'ETH vs WETH')!;
  assert(!!ew && near(ew.stats.maxDevPct, 1, 1e-6) && near(ew.stats.maxNetPct, 0.9, 1e-6), 'ETH vs WETH pools: 1% apart, 0.9% after both fees');
  assert(mon.statusLine().includes('broken coin(s) ignored'), 'status page line');

  // Report + verdict.
  const rep = formatLoopReport({ dateLabel: '2026-10-09', hours: 2, tokens: mon.tokenCount(), quotes: mon.quoteList(), rows, pegs });
  assert(rep.includes('LOOP REPORT') && rep.includes('HOOD: up to 1.61% after fees') && rep.includes('Ignored as broken') && rep.includes('JUNK'), 'report lists the paying loop and the ignored junk coin');
  assert(rep.includes('Dollars (USDG, USDT)') && rep.includes('HOOD: ETH pool vs WETH pool (ETH vs WETH): up to 1.00% apart') && !rep.includes('—'), 'report shows groups in plain English, no em dashes');
  assert(loopVerdict(rows, pegs).startsWith('⚠️'), 'one good token only -> keep measuring');
  const two = [...rows, { ...hood, token: 'x', symbol: 'AMZN' }];
  assert(loopVerdict(two, pegs).startsWith('✅'), 'two tokens with 0.3%+ lasting minutes -> worth building');
  assert(loopVerdict([], []).startsWith('⏳'), 'nothing measured -> wait');
  const none = rows.map((r) => ({ ...r, stats: { ...r.stats, maxNetPct: -0.2, secondsProfitable: 0, longestRunS: 0 } }));
  assert(loopVerdict(none, []).startsWith('❌'), 'nothing after fees -> not worth building');
  // A "paying" loop over 10% after fees is not believed.
  const wild = [{ ...hood, broken: false, stats: { ...hood.stats, maxNetPct: 25 } }];
  assert(loopVerdict(wild, []).startsWith('❌') && formatLoopReport({ dateLabel: 'x', hours: 1, tokens: 1, quotes: [], rows: wild, pegs: [] }).includes('probably a junk coin'), 'over 10% after fees is flagged, not counted');

  // Save / load across a restart, then a new period after the report.
  const file = `.test-build/loops-${process.pid}.json`;
  mon.save(file);
  const again = new LoopMonitor(fakeCallMany, () => clock);
  again.load(file);
  require('fs').unlinkSync(file);
  assert(near(again.rows().find((r) => r.symbol === 'HOOD')!.stats.maxNetPct, expNet, 1e-6) && again.pegRows().length === pegs.length, 'restart keeps the period numbers');
  assert(again.rows().every((r) => r.stats.curRunS === 0), 'a restart does not continue a stretch across the gap');
  mon.resetPeriod();
  assert(!mon.rows().length && !mon.pegRows().length, 'new period starts empty after a report');
}
main();
