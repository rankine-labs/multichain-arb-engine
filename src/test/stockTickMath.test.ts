import { getSqrtRatioAtTick, getTickAtSqrtRatio, swapExactInTicks, v4SwapFeePips, MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO, TickWindow } from '../core/tickMath';
import { TickWindowBook, tickBook, tickAwareAmountOut } from '../core/tickWindow';
import { computeAmountOut } from '../core/dexMath';
import { PoolState } from '../core/types';
import { RECORDED, RecordedPool } from './stockTickMath.fixtures';
import { ethers } from 'ethers';

// ============================================================================
// STOCK POOL "PHANTOM GAPS" (Nov 2, STOCK_TICK_MATH): the quick guess must
// match what the chain's own quoter says, on REAL recorded pool state
// (block 104474563, see stockTickMath.fixtures.ts).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// --- 1. Uniswap's TickMath constants, copied exactly -------------------------
assert(getSqrtRatioAtTick(MIN_TICK) === MIN_SQRT_RATIO, 'sqrt price at the lowest tick = Uniswap MIN_SQRT_RATIO');
assert(getSqrtRatioAtTick(MAX_TICK) === MAX_SQRT_RATIO, 'sqrt price at the highest tick = Uniswap MAX_SQRT_RATIO');
assert(getSqrtRatioAtTick(0) === 1n << 96n, 'tick 0 = price 1');
let tickRoundTrip = true;
for (const t of [-887000, -219871, -1, 0, 1, 204119, 243106, 886000]) {
  const s = getSqrtRatioAtTick(t);
  if (getTickAtSqrtRatio(s) !== t || getTickAtSqrtRatio(s - 1n) !== t - 1) tickRoundTrip = false;
}
assert(tickRoundTrip, 'price -> tick gives back the same tick (and one less just under it)');
for (const r of RECORDED) assert(getTickAtSqrtRatio(BigInt(r.sqrtP)) === r.tick, `${r.label} ${r.k}: tick worked out from the price = the pool's own tick (${r.tick})`);

// --- 2. V4 protocol fee -------------------------------------------------------
// 4097000 = 1000 pips each way (0.10%); Uniswap: protocol + lp - protocol*lp/1e6.
assert(v4SwapFeePips(10000, 4097000, true) === 10990 && v4SwapFeePips(10000, 4097000, false) === 10990, 'V4 swap fee: 1% LP + 0.10% protocol = 1.099%');
assert(v4SwapFeePips(3000, 0, true) === 3000, 'V4 swap fee: no protocol fee = LP fee');
assert(v4SwapFeePips(4000, (500 << 12) | 700, true) === 4698 && v4SwapFeePips(4000, (500 << 12) | 700, false) === 4498, 'V4 protocol fee is per direction (low 12 bits = token0 in)');

// --- 3. Tick walk vs the chain's own quoter (recorded) --------------------------
const winOf = (r: RecordedPool): TickWindow => ({ lo: r.win.lo, hi: r.win.hi, tickSpacing: r.ts, ticks: r.win.ticks.map(([tick, n]) => ({ tick, liquidityNet: BigInt(n) })), block: 104474563, ms: 0 });
const feeOf = (r: RecordedPool, z: boolean) => (r.dex === 'uniswap-v4' ? v4SwapFeePips(r.lpFee, r.protocolFee, z) : r.lpFee);
const oldGuess = (r: RecordedPool, z: boolean, amt: bigint) => {
  // The bot's old single-range maths (dexMath V3 branch), LP fee only.
  const Q96 = 1n << 96n, s = BigInt(r.sqrtP), L = BigInt(r.L);
  const vx = (L * Q96) / s, vy = (L * s) / Q96, inF = (amt * (1_000_000n - BigInt(r.lpFee))) / 1_000_000n;
  return z ? vy - (vx * vy) / (vx + inF) : vx - (vx * vy) / (vy + inF);
};
let exactCount = 0, revertCount = 0;
for (const r of RECORDED) {
  for (const c of r.cases) {
    const amt = BigInt(c.amountIn);
    const tw = swapExactInTicks({ sqrtPriceX96: BigInt(r.sqrtP), liquidity: BigInt(r.L), tick: r.tick, feePips: feeOf(r, c.zeroForOne), window: winOf(r), zeroForOne: c.zeroForOne, amountIn: amt });
    const dir = c.zeroForOne ? 'token0 in' : 'token1 in';
    if (c.quoter !== 'revert') {
      assert(!!tw && tw.amountOut === BigInt(c.quoter), `${r.label} ${r.k} ${dir}: tick walk = chain quoter EXACTLY (${c.quoter})`);
      exactCount++;
    } else {
      // The pool can't fill it: the walk must run out of liquidity and give
      // back next to nothing compared with the old guess.
      const g = oldGuess(r, c.zeroForOne, amt);
      assert(!!tw && tw.leftWindow && tw.amountOut < g, `${r.label} ${r.k} ${dir}: pool can't fill it; new guess ${tw?.amountOut} counts only what it can fill (old guess ${g})`);
      // Wrong side of a one-position pool: next to nothing (under 1% of the old guess).
      const edgeTick = r.win.ticks.length === 1 ? r.win.ticks[0][0] : null;
      if (edgeTick !== null && ((edgeTick === r.tick + 1 && !c.zeroForOne) || (edgeTick === r.tick && c.zeroForOne))) assert(tw!.amountOut * 100n < g, `${r.label} ${r.k} ${dir}: price at the edge, new guess under 1% of the old one`);
      revertCount++;
    }
  }
}
assert(exactCount === 13 && revertCount === 7, `checked 13 exact matches and 7 "not enough liquidity" cases (got ${exactCount}, ${revertCount})`);

// --- 4. Through the bot's real guess function, flag on vs off -------------------
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const stateOf = (r: RecordedPool, id: string): PoolState => ({
  chain: 'robinhood', dex: r.dex, poolAddress: id, poolType: 'v3', tokenA: r.decA === 6 ? USDG : '0x' + '11'.repeat(20), tokenB: r.decB === 6 ? USDG : '0x' + '22'.repeat(20),
  sqrtPriceX96: BigInt(r.sqrtP), liquidity: BigInt(r.L), feeBps: r.lpFee / 100, lastUpdatedBlock: 104474563, lastUpdatedMs: Date.now(),
  ...(r.dex === 'uniswap-v4' ? { v4: { fee: r.lpFee, tickSpacing: r.ts, native: false, poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951', stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' } } : {}),
});
const idFor = (r: RecordedPool) => (r.dex === 'uniswap-v4' ? r.k + 'ab'.repeat(28) : r.k + 'cd'.repeat(16));
for (const r of RECORDED) tickBook.put(idFor(r), winOf(r), r.protocolFee);
const R = (k: string) => RECORDED.find((x) => x.k === k)!;
const sndkDeep = stateOf(R('0x2707cb88'), idFor(R('0x2707cb88')));
const sndkEdge = stateOf(R('0x6d65849d'), idFor(R('0x6d65849d')));
const usdg1100 = 1_100_000_000n;

// The logged phantom route: USDG/SNDK uniswap-v4@0x2707cb88 -> uniswap-v4@0x6d65849d, $1,100.
const withFlag = (v: string | undefined, f: () => bigint | null) => { const old = process.env.STOCK_TICK_MATH; if (v === undefined) delete process.env.STOCK_TICK_MATH; else process.env.STOCK_TICK_MATH = v; try { return f(); } finally { if (old === undefined) delete process.env.STOCK_TICK_MATH; else process.env.STOCK_TICK_MATH = old; } };
const roundTrip = () => { const sndk = computeAmountOut(sndkDeep, true, usdg1100)!; return computeAmountOut(sndkEdge, false, sndk)!; };
const oldBack = withFlag('0', roundTrip), newBack = withFlag(undefined, roundTrip);
const usd = (x: bigint) => Number(x) / 1e6;
console.log(`  SNDK route $1,100: old guess back $${usd(oldBack).toFixed(2)} (gap $${(usd(oldBack) - 1100).toFixed(2)}), new guess back $${usd(newBack).toFixed(2)}`);
assert(usd(oldBack) - 1100 > 100, 'old maths: the SNDK route shows a phantom gap of more than $100 (what the log kept showing)');
assert(usd(newBack) < 1, 'new maths: the same route gives back under $1 (the second pool has nothing to buy SNDK with)');
// The deep pool on its own: new guess = quoter exactly (V4 protocol fee included).
assert(withFlag(undefined, () => computeAmountOut(sndkDeep, true, usdg1100)) === 991518088464827990n, 'computeAmountOut on the deep SNDK pool = chain quoter exactly');
assert(withFlag('0', () => computeAmountOut(sndkDeep, true, usdg1100)) === oldGuess(R('0x2707cb88'), true, usdg1100), 'STOCK_TICK_MATH=0: computeAmountOut is exactly the old maths');
// GOOGL V3: selling ~$1,100 of GOOGL.
const googlV3 = stateOf(R('0x553e9a45'), idFor(R('0x553e9a45')));
const googlIn = 3888461996000000000n;
const gOld = withFlag('0', () => computeAmountOut(googlV3, true, googlIn))!, gNew = withFlag(undefined, () => computeAmountOut(googlV3, true, googlIn))!;
console.log(`  GOOGL V3 sell ~$1,100: old guess $${usd(gOld).toFixed(2)}, new guess $${usd(gNew).toFixed(2)}, chain quoter $112.31`);
assert(gNew >= 112308684n && gNew - 112308684n <= 2n, 'GOOGL V3 sell: new guess = quoter (to 2 millionths of a dollar)');
assert(usd(gOld) > 1000, 'GOOGL V3 sell: old guess was over $1,000 (phantom)');

// --- 5. No window yet / other pools: old maths, and the pool gets queued -------
const fresh = new TickWindowBook({ now: () => 1_000 });
const unknown = { ...sndkDeep, poolAddress: '0x' + 'ee'.repeat(32) };
assert(tickAwareAmountOut(unknown, true, usdg1100, 10000, fresh) === undefined && fresh.pendingCount() === 1, 'no window loaded yet: old maths, and the pool is queued for a read');
const algebra = { ...googlV3, poolAddress: '0x' + 'aa'.repeat(20), variant: 'algebra' as const };
assert(tickAwareAmountOut(algebra, true, googlIn, 3000, fresh) === undefined && fresh.pendingCount() === 1, 'Algebra pools are left alone (different tick layout)');
const v2: PoolState = { ...googlV3, poolType: 'v2', reserveA: 10n ** 18n, reserveB: 10n ** 6n };
assert(tickAwareAmountOut(v2, true, 1000n, 3000, fresh) === undefined, 'V2 pools are left alone');
const hooked = { ...sndkDeep, poolAddress: '0x' + 'ef'.repeat(32), v4: { ...sndkDeep.v4!, hooks: '0x000000000000000000000000000000000000008c' } };
assert(tickAwareAmountOut(hooked, true, usdg1100, 10000, fresh) === undefined && fresh.pendingCount() === 1, 'V4 hook that can change amounts: left alone (not queued)');
// Price moved out of the window: old maths + re-read queued.
const book2 = new TickWindowBook({ now: () => 1_000 });
book2.put(sndkEdge.poolAddress, { ...winOf(R('0x6d65849d')), lo: 100_000, hi: 100_100 });
assert(tickAwareAmountOut(sndkEdge, false, 10n ** 17n, 4000, book2) === undefined && book2.pendingCount() === 1, 'price outside the loaded window: old maths and a re-read is queued');
// Old window: re-read asked for, still used until TICK_WINDOW_MAX_AGE_MS.
let t = 0; const book3 = new TickWindowBook({ now: () => t, refreshMs: 100, maxAgeMs: 1_000 });
book3.put(sndkDeep.poolAddress, winOf(R('0x2707cb88')), R('0x2707cb88').protocolFee);
t = 500; const mid = tickAwareAmountOut(sndkDeep, true, usdg1100, 10000, book3);
assert(mid === 991518088464827990n && book3.pendingCount() === 1, 'window older than the refresh time: still used, re-read queued');
t = 2_000; assert(tickAwareAmountOut(sndkDeep, true, usdg1100, 10000, book3) === undefined, 'window older than the max age: not trusted (old maths)');

// --- 6. Price exactly on a range edge: the more careful reading is used -------
{
  const r = R('0xfa29c8b2');
  const onEdge: PoolState = { ...stateOf(r, '0x' + 'fa'.repeat(32)), sqrtPriceX96: getSqrtRatioAtTick(-219300) };
  const b = new TickWindowBook(); b.put(onEdge.poolAddress, winOf(r), r.protocolFee);
  const down = tickAwareAmountOut(onEdge, true, 10n ** 18n, r.lpFee, b);
  assert(down !== undefined && down !== null && down === 0n, 'price exactly on the bottom edge: selling GOOGL down gives nothing (not a double-counted range)');
}

// --- 7. The background reader decodes real call answers ----------------------
(async () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const r = R('0x6d65849d');
  const st = stateOf(r, '0x' + '6d'.repeat(32));
  const ts = r.ts, w0 = Math.floor(Math.floor(r.tick / ts) / 256);
  const sel = (s: string) => ethers.id(s).slice(0, 10);
  const calls: string[] = [];
  const callMany = async (cs: { target: string; data: string }[]) => cs.map((c) => {
    calls.push(c.data.slice(0, 10));
    if (c.data.startsWith(sel('getSlot0(bytes32)'))) return coder.encode(['uint160', 'int24', 'uint24', 'uint24'], [BigInt(r.sqrtP), r.tick, r.protocolFee, r.lpFee]);
    if (c.data.startsWith(sel('getTickBitmap(bytes32,int16)'))) {
      const w = Number(coder.decode(['int16'], '0x' + c.data.slice(74))[0]);
      let bm = 0n; for (const [tk] of r.win.ticks) { const comp = Math.floor(tk / ts); if (comp >> 8 === w) bm |= 1n << BigInt(comp & 255); }
      // Also the position's lower edge (200640), as on chain.
      { const comp = Math.floor(200640 / ts); if (comp >> 8 === w) bm |= 1n << BigInt(comp & 255); }
      return coder.encode(['uint256'], [bm]);
    }
    if (c.data.startsWith(sel('getTickLiquidity(bytes32,int24)'))) {
      const tk = Number(coder.decode(['int24'], '0x' + c.data.slice(74))[0]);
      const net = tk === 204120 ? -1487559002642616n : tk === 200640 ? 1487559002642616n : 0n;
      return coder.encode(['uint128', 'int128'], [net < 0n ? -net : net, net]);
    }
    return null;
  });
  const b = new TickWindowBook({ now: () => 5, words: 2 });
  b.want(st);
  const n = await b.loadPending(callMany);
  const out = tickAwareAmountOut(st, true, 1_100_000_000n, r.lpFee, b);
  assert(n === 1 && b.protocolFee(st) === r.protocolFee, 'reader: V4 window and protocol fee loaded from StateView answers');
  assert(out === 785527899553004784n, 'reader: guess from the loaded window = chain quoter exactly');
  assert(calls.filter((c) => c === sel('getTickBitmap(bytes32,int16)')).length === 5, 'reader: 5 bitmap words read (2 each side + the current one)');
  // A V3 copy whose reads fail: old maths for that pool for an hour.
  const bad = new TickWindowBook({ now: () => 5 });
  const v3 = stateOf(R('0x553e9a45'), '0x' + '55'.repeat(20));
  bad.want(v3);
  await bad.loadPending(async (cs) => cs.map(() => null));
  assert(tickAwareAmountOut(v3, true, 10n ** 18n, 3000, bad) === undefined && bad.pendingCount() === 0, 'reader: a pool whose ticks cannot be read stays on old maths (not re-asked every round)');

  // --- 8. Speed: the bot prices pools a lot while sizing trades ----------------
  const N = 20_000; const amts = Array.from({ length: 64 }, (_, i) => BigInt(50 + i * 47) * 1_000_000n);
  const time = (f: () => void) => { const t0 = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t0) / 1e3 / N; };
  const usOld = withFlag('0', () => { const x = time(() => { for (let i = 0; i < N; i++) computeAmountOut(sndkDeep, true, amts[i & 63]); }); return BigInt(Math.round(x * 1000)); });
  const usNew = withFlag(undefined, () => { const x = time(() => { for (let i = 0; i < N; i++) computeAmountOut(sndkDeep, true, amts[i & 63]); }); return BigInt(Math.round(x * 1000)); });
  console.log(`  speed: old ${(Number(usOld) / 1000).toFixed(2)} us per guess, new ${(Number(usNew) / 1000).toFixed(2)} us per guess`);
  assert(Number(usNew) / 1000 < 150, 'new guess stays well under 150 microseconds');
})();
