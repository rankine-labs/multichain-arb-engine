// ============================================================================
// GUN TEST VECTORS: run the REAL TypeScript code, write what it produced.
//
// Plain English:
//   The Rust sender (sim/src/fastlane/gun/) must build EXACTLY the same bytes
//   as the Node bot: the same ArbExecutor calldata (execute /
//   executeWithV3Flash), the same refusals (same reason text), the same token
//   amounts (same float rounding), the same lender choice, and the same signed
//   transaction. This script calls the bot's own functions
//   (src/execution/executorCalldata.ts and ethers' Wallet, which is what
//   src/execution/fastSender.ts signs with) on a broad set of inputs and saves
//   inputs + answers as JSON. The Rust test sim/tests/gun_vectors.rs replays
//   every case and demands identical bytes / identical refusals.
//
//   Floats are stored twice: as a readable number and as their exact 64-bit
//   pattern ("...Bits"), so no JSON float parsing difference can creep in.
//   Big numbers are decimal strings. Nothing here touches a network.
//
// Run (from the repo root, node_modules installed):
//   npx tsc -p sim/tests/vectors/tsconfig.json && node .scripts-build/sim/tests/vectors/gen-calldata-vectors.js
// Writes sim/tests/vectors/calldata.json and sim/tests/vectors/tx.json.
// The test keys below are well-known throwaway keys (never funded, never used live).
// ============================================================================
import { writeFileSync } from 'fs';
import { join } from 'path';
import { AbiCoder, Wallet, getAddress, keccak256, Transaction } from 'ethers';
import {
  buildExecuteCall, encodeExecuteRaw, encodeExecuteV3FlashRaw, pickV3Lender, usdToTokenUnits,
  BuildInput, ExecutorHop, KIND_V2, KIND_SOLIDLY, KIND_V3, KIND_V4, KIND_V4_HOOKED,
} from '../../../src/execution/executorCalldata';
import { PoolState } from '../../../src/core/types';

// Repo root regardless of where the compiled copy runs from.
const OUT_DIR = join(process.cwd(), 'sim', 'tests', 'vectors');

// ---------------------------------------------------------------------------
// Deterministic pseudo-random numbers (same file every run).
// ---------------------------------------------------------------------------
let seed = 0x5eed1234;
function rnd(): number {
  // mulberry32
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
function randAddr(): string {
  let h = '';
  for (let i = 0; i < 40; i++) h += Math.floor(rnd() * 16).toString(16);
  // Mix of all-lowercase and checksummed spellings (both valid for ethers).
  return rnd() < 0.5 ? '0x' + h : getAddress('0x' + h);
}

// Exact bits of a float, as 0x + 16 hex digits.
function bits(x: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  return '0x' + dv.getBigUint64(0).toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------
const WETH = '0x0bd7d308f8f2b5c5d4e5c2bd3c6d5a1f8b7a9e01';
const USDC = getAddress('0x6c3ea9036406852006290770bedfcaba0e23a0e8');
const TSLA = '0x3ff1a3bd1f8e8d7e9c3f5a2b1c0d9e8f7a6b5c4d';
const PM = getAddress('0x000000000004444c5dc75cb358380d2e3de08a90'); // a PoolManager-like address
const HOOK = getAddress('0x9c6d2a3e1f0b8a7c6d5e4f3a2b1c0d9e8f7a60cc');

function pool(dex: string, poolType: PoolState['poolType'], addr: string, a = USDC, b = WETH, feeBps = 30, extra: Partial<PoolState> = {}): PoolState {
  return { chain: 'robinhood', dex, poolAddress: addr, poolType, tokenA: a, tokenB: b, feeBps, lastUpdatedBlock: 1, lastUpdatedMs: 0, ...extra };
}

// A V4 pool whose poolAddress is the REAL id of its key (so hooked ones pass the key check).
function v4Pool(dex: string, a: string, b: string, fee: number, tick: number, native: boolean, hooks: string | undefined, idOverride?: string): PoolState {
  const c0 = native ? '0x0000000000000000000000000000000000000000' : a;
  const h = hooks && hooks.toLowerCase() !== '0x0000000000000000000000000000000000000000' ? hooks : '0x0000000000000000000000000000000000000000';
  let id = idOverride;
  if (!id) {
    try {
      id = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, b, fee, tick, h]));
    } catch { id = '0x' + '11'.repeat(32); }
  }
  return pool(dex, 'v3', id, a, b, 0, { v4: { fee, tickSpacing: tick, native, poolManager: PM, stateView: PM, ...(hooks !== undefined ? { hooks } : {}) } });
}

// Serialize a pool for the Rust side (only what the calldata code reads).
function poolJson(p: PoolState) {
  return {
    dex: p.dex, poolAddress: p.poolAddress, poolType: p.poolType, tokenA: p.tokenA, tokenB: p.tokenB,
    feeBps: p.feeBps, variant: p.variant ?? null,
    liquidity: p.liquidity === undefined ? null : p.liquidity.toString(),
    v4: p.v4 ? { fee: p.v4.fee, tickSpacing: p.v4.tickSpacing, native: p.v4.native, poolManager: p.v4.poolManager, hooks: p.v4.hooks ?? null } : null,
  };
}
function hopJson(h: ExecutorHop) {
  return {
    kind: h.kind, pool: h.pool, tokenIn: h.tokenIn, tokenOut: h.tokenOut, feeBps: h.feeBps,
    v4Fee: h.v4Fee ?? 0, v4TickSpacing: h.v4TickSpacing ?? 0, v4Native: h.v4Native ?? false,
    v4PoolManager: h.v4PoolManager ?? null,
  };
}

// ---------------------------------------------------------------------------
// 1. buildExecuteCall cases (2-pool plans: every pool kind, refusals, funding)
// ---------------------------------------------------------------------------
const P = {
  v2: pool('uniswap-v2', 'v2', '0x1111111111111111111111111111111111111111', USDC, WETH, 25),
  v2b: pool('pancakeswap-v2', 'v2', getAddress('0x2222222222222222222222222222222222222abc'), WETH, USDC, 30),
  sol: pool('Ramses', 'v2', '0x3333333333333333333333333333333333333333', USDC, WETH, 5),
  pha: pool('pharaoh', 'v2', '0x3333333333333333333333333333333333333334', WETH, USDC, 2),
  v3: pool('uniswap-v3', 'v3', '0x4444444444444444444444444444444444444444', WETH, USDC, 5),
  v3copy: pool('giga-cl', 'v3', '0x4444444444444444444444444444444444444445', USDC, WETH, 1),
  alg: pool('alandale', 'v3', '0x5555555555555555555555555555555555555555', USDC, WETH, 10, { variant: 'algebra' }),
  algV4: pool('kittenswap', 'v3', '0x5555555555555555555555555555555555555556', USDC, WETH, 10, { variant: 'algebra', v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: PM, stateView: PM } }),
  kuru: pool('kuru', 'orderbook', '0x6666666666666666666666666666666666666666'),
  lb: pool('LFJ-LB', 'v3', '0x6666666666666666666666666666666666666667'),
  bean: pool('bean-exchange', 'v2', '0x6666666666666666666666666666666666666668'),
  stable: pool('curve', 'stable', '0x6666666666666666666666666666666666666669'),
  v4: v4Pool('uniswap-v4', WETH, USDC, 3000, 60, false, undefined),
  v4native: v4Pool('uniswap-v4', WETH, USDC, 500, 10, true, '0x0000000000000000000000000000000000000000'),
  v4neg: v4Pool('uniswap-v4', USDC, WETH, 100, 1, false, undefined),
  v4noinfo: pool('uniswap-v4', 'v3', '0x' + '77'.repeat(32), WETH, USDC),
  fables: v4Pool('fables', WETH, USDC, 0x800000, 60, false, HOOK),
  fablesUni: v4Pool('uniswap-v4', USDC, WETH, 0x800000, 200, true, HOOK),
  fablesBadId: v4Pool('fables', WETH, USDC, 0x800000, 60, false, HOOK, '0x' + 'ab'.repeat(32)),
  fablesBadFee: v4Pool('fables', WETH, USDC, 0x1000000, 60, false, HOOK, '0x' + 'cd'.repeat(32)),
  fablesBadTick: v4Pool('fables', WETH, USDC, 3000, 9_000_000, false, HOOK, '0x' + 'ce'.repeat(32)),
  otherV4Hookless: pool('fables', 'v3', '0x' + '88'.repeat(32), WETH, USDC, 0, { v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: PM, stateView: PM } }),
  tslaV2: pool('uniswap-v2', 'v2', '0x9999999999999999999999999999999999999999', TSLA, USDC, 30),
  wideFee: pool('uniswap-v2', 'v2', '0x1111111111111111111111111111111111111112', USDC, WETH, 70_000),
};

interface Case { name: string; input: BuildInput }
const cases: Case[] = [];
const baseIn = (buy: PoolState, sell: PoolState, over: Partial<BuildInput> = {}): BuildInput => ({
  chain: 'robinhood', tokenIn: WETH, buyPool: buy, sellPool: sell,
  tradeSizeUsd: 1_000, netProfitUsd: 2.5, usdPerTokenIn: 3_412.77, tokenInDecimals: 18, maxBlock: 12_345_678n, ...over,
});
// Every pair of pool kinds, both directions, own money.
const tradeable = ['v2', 'v2b', 'sol', 'pha', 'v3', 'v3copy', 'alg', 'v4', 'v4native', 'v4neg', 'fables', 'fablesUni'] as const;
for (const a of tradeable) for (const b of tradeable) {
  if (a === b) continue;
  cases.push({ name: `pair ${a} -> ${b}`, input: baseIn(P[a], P[b]) });
}
// Refusals: unsupported pools, bad hooked keys, broken routes, decimals, rounding.
for (const bad of ['kuru', 'lb', 'bean', 'stable', 'v4noinfo', 'algV4', 'otherV4Hookless', 'fablesBadId', 'fablesBadFee', 'fablesBadTick'] as const) {
  cases.push({ name: `refuse buy ${bad}`, input: baseIn(P[bad], P.v3) });
  cases.push({ name: `refuse sell ${bad}`, input: baseIn(P.v2, P[bad]) });
}
cases.push({ name: 'tokenIn not in buy pool', input: baseIn(P.tslaV2, P.v3) });
cases.push({ name: 'sell pool does not trade back', input: baseIn(P.v2, P.tslaV2) });
cases.push({ name: 'tokenIn case-insensitive', input: baseIn(P.v2, P.v3, { tokenIn: getAddress(WETH) }) });
cases.push({ name: 'unknown decimals', input: baseIn(P.v2, P.v3, { tokenInDecimals: undefined }) });
cases.push({ name: 'size rounds to zero', input: baseIn(P.v2, P.v3, { tradeSizeUsd: 1e-12 }) });
cases.push({ name: 'profit rounds to zero', input: baseIn(P.v2, P.v3, { netProfitUsd: 1e-13 }) });
cases.push({ name: 'zero size', input: baseIn(P.v2, P.v3, { tradeSizeUsd: 0 }) });
cases.push({ name: 'negative profit', input: baseIn(P.v2, P.v3, { netProfitUsd: -1 }) });
cases.push({ name: 'NaN price', input: baseIn(P.v2, P.v3, { usdPerTokenIn: NaN }) });
cases.push({ name: 'infinite size', input: baseIn(P.v2, P.v3, { tradeSizeUsd: Infinity }) });
cases.push({ name: 'tiny price huge amount (overflow throws)', input: baseIn(P.v2, P.v3, { usdPerTokenIn: 1e-300, tradeSizeUsd: 1e10 }) });
cases.push({ name: 'huge amount, profit rounds to zero', input: baseIn(P.v2, P.v3, { usdPerTokenIn: 1e-60, tradeSizeUsd: 1e30, netProfitUsd: 1e-80 }) });
cases.push({ name: 'v2 fee over uint16 (throws)', input: baseIn(P.wideFee, P.v3) });
// Decimals 0..36 and USDC-style 6.
for (const d of [0, 1, 2, 6, 8, 9, 10, 12, 18, 24, 30, 36]) {
  cases.push({ name: `decimals ${d}`, input: baseIn(P.v2, P.v3, { tokenInDecimals: d, tradeSizeUsd: 1234.5678, netProfitUsd: 0.123456 }) });
}
// Funding: Aave, V3 lender, lender clashes with a trade pool (pool / PoolManager / hook).
const LENDER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const AAVE = getAddress('0x794a61358d6845594f94dc1db02a252b5b4814ad');
const EXEC = getAddress('0x1f9840a85d5af5bf1d1762f925bdaddc4201f984');
cases.push({ name: 'aave funding', input: baseIn(P.v2, P.v3, { flashPool: AAVE, executorAddress: EXEC }) });
cases.push({ name: 'zero flash pool = own', input: baseIn(P.v2, P.v3, { flashPool: '0x0000000000000000000000000000000000000000' }) });
cases.push({ name: 'v3 lender', input: baseIn(P.v2, P.v3, { v3Lender: LENDER, executorAddress: EXEC }) });
cases.push({ name: 'v3 lender wins over aave', input: baseIn(P.v2, P.v3, { v3Lender: LENDER, flashPool: AAVE }) });
cases.push({ name: 'lender is buy pool', input: baseIn(P.v2, P.v3, { v3Lender: P.v2.poolAddress.toUpperCase().replace('0X', '0x') }) });
cases.push({ name: 'lender is sell pool', input: baseIn(P.v2, P.v3, { v3Lender: P.v3.poolAddress }) });
cases.push({ name: 'lender is the PoolManager', input: baseIn(P.v4, P.v3, { v3Lender: PM }) });
cases.push({ name: 'lender is the hook', input: baseIn(P.fables, P.v3, { v3Lender: HOOK }) });
cases.push({ name: 'v4 with v3 lender', input: baseIn(P.v4native, P.fablesUni, { v3Lender: LENDER }) });
cases.push({ name: 'max block zero', input: baseIn(P.v2, P.v3, { maxBlock: 0n }) });
cases.push({ name: 'max block huge', input: baseIn(P.v2, P.v3, { maxBlock: (1n << 255n) + 12345n }) });
cases.push({ name: 'max block over uint256 (throws)', input: baseIn(P.v2, P.v3, { maxBlock: 1n << 256n }) });
cases.push({ name: 'start in USDC', input: baseIn(P.v2, P.v3, { tokenIn: USDC, usdPerTokenIn: 0.99987, tokenInDecimals: 6, tradeSizeUsd: 250.5, netProfitUsd: 0.11 }) });
// Random sizes/prices/decimals over random tradeable pairs (float rounding coverage).
for (let i = 0; i < 300; i++) {
  const a = pick([...tradeable]); let b = pick([...tradeable]); if (b === a) b = 'v3';
  const lender = rnd() < 0.3 ? randAddr() : undefined;
  const aave = !lender && rnd() < 0.3 ? randAddr() : undefined;
  cases.push({
    name: `random ${i}`,
    input: baseIn(P[a], P[b], {
      tradeSizeUsd: Math.exp(rnd() * 25 - 8),
      netProfitUsd: Math.exp(rnd() * 20 - 12),
      usdPerTokenIn: Math.exp(rnd() * 40 - 20),
      tokenInDecimals: Math.floor(rnd() * 31),
      maxBlock: BigInt(Math.floor(rnd() * 2 ** 40)),
      v3Lender: lender, flashPool: aave,
      executorAddress: rnd() < 0.5 ? EXEC : undefined,
    }),
  });
}

function buildCaseJson(c: Case) {
  const i = c.input;
  const input = {
    tokenIn: i.tokenIn, buyPool: poolJson(i.buyPool), sellPool: poolJson(i.sellPool),
    tradeSizeUsd: i.tradeSizeUsd, tradeSizeUsdBits: bits(i.tradeSizeUsd),
    netProfitUsd: i.netProfitUsd, netProfitUsdBits: bits(i.netProfitUsd),
    usdPerTokenIn: i.usdPerTokenIn, usdPerTokenInBits: bits(i.usdPerTokenIn),
    tokenInDecimals: i.tokenInDecimals ?? null, maxBlock: i.maxBlock.toString(),
    executorAddress: i.executorAddress ?? null, flashPool: i.flashPool ?? null, v3Lender: i.v3Lender ?? null,
  };
  let expect: unknown;
  try {
    const r = buildExecuteCall(i);
    expect = r.ok
      ? { ok: true, to: r.to ?? null, data: r.data, amountIn: r.amountIn.toString(), minProfit: r.minProfit.toString(), flashPool: r.flashPool, funding: r.funding, hops: r.hops.map(hopJson) }
      : { ok: false, reason: (r as { reason: string }).reason };
  } catch (e) {
    expect = { throws: String((e as Error).message).slice(0, 120) };
  }
  return { name: c.name, input, expect };
}

// ---------------------------------------------------------------------------
// 2. encodeExecuteRaw / encodeExecuteV3FlashRaw (multi-hop loops, as used by
//    the trigger-entry and loop senders): 1..6 hops, every kind, edge values.
// ---------------------------------------------------------------------------
function randHop(): ExecutorHop {
  const kind = pick([KIND_V2, KIND_SOLIDLY, KIND_V3, KIND_V4, KIND_V4_HOOKED]);
  const v4 = kind === KIND_V4 || kind === KIND_V4_HOOKED;
  const h: ExecutorHop = { kind, pool: randAddr(), tokenIn: randAddr(), tokenOut: randAddr(), feeBps: kind === KIND_V2 ? Math.floor(rnd() * 100) : 0 };
  if (v4) {
    h.v4Fee = pick([100, 500, 3000, 10000, 0x800000, 0xffffff, 0]);
    h.v4TickSpacing = pick([1, 10, 60, 200, -1, -8388608, 8388607, 0]);
    h.v4Native = rnd() < 0.5;
    if (kind === KIND_V4_HOOKED) h.v4PoolManager = randAddr(); // bot-only field: must NOT be encoded
  } else if (rnd() < 0.3) {
    // Some callers leave V4 fields out entirely, others fill them with zeros.
    h.v4Fee = 0; h.v4TickSpacing = 0; h.v4Native = false;
  }
  return h;
}
const bigEdges = [0n, 1n, 127n, 128n, 255n, 256n, 10n ** 18n, (1n << 128n) - 1n, (1n << 255n), (1n << 256n) - 1n];
const raw: unknown[] = [];
for (let i = 0; i < 200; i++) {
  const nh = 1 + Math.floor(rnd() * 6);
  const hops = Array.from({ length: nh }, randHop);
  const trade = {
    token: randAddr(),
    amountIn: rnd() < 0.3 ? pick(bigEdges) : BigInt(Math.floor(rnd() * 1e15)) * 10n ** BigInt(Math.floor(rnd() * 10)),
    minProfit: rnd() < 0.3 ? pick(bigEdges) : BigInt(Math.floor(rnd() * 1e12)),
    maxBlock: rnd() < 0.2 ? pick(bigEdges) : BigInt(Math.floor(rnd() * 2 ** 40)),
    hops,
  };
  const lender = rnd() < 0.5 ? randAddr() : null;
  const flash = !lender && rnd() < 0.5 ? randAddr() : null;
  let expect: unknown;
  try {
    expect = { data: lender ? encodeExecuteV3FlashRaw(trade, lender) : flash ? encodeExecuteRaw(trade, flash) : encodeExecuteRaw(trade) };
  } catch (e) {
    expect = { throws: String((e as Error).message).slice(0, 120) };
  }
  raw.push({
    name: `raw ${i}`, lender, flashPool: flash,
    trade: { token: trade.token, amountIn: trade.amountIn.toString(), minProfit: trade.minProfit.toString(), maxBlock: trade.maxBlock.toString(), hops: hops.map(hopJson) },
    expect,
  });
}
// Out-of-range hop values must throw on both sides.
for (const [label, over] of [
  ['kind 256', { kind: 256 }], ['feeBps 65536', { feeBps: 65_536 }], ['v4Fee 2^24', { v4Fee: 0x1000000 }],
  ['tick 2^23', { v4TickSpacing: 8_388_608 }], ['tick -2^23-1', { v4TickSpacing: -8_388_609 }],
] as const) {
  const h = { ...randHop(), ...over } as ExecutorHop;
  const trade = { token: WETH, amountIn: 5n, minProfit: 1n, maxBlock: 9n, hops: [h] };
  let expect: unknown;
  try { expect = { data: encodeExecuteRaw(trade) }; } catch (e) { expect = { throws: String((e as Error).message).slice(0, 120) }; }
  raw.push({ name: `raw bad ${label}`, lender: null, flashPool: null, trade: { token: trade.token, amountIn: '5', minProfit: '1', maxBlock: '9', hops: [hopJson(h)] }, expect });
}
// amountIn over uint256 throws.
{
  const trade = { token: WETH, amountIn: 1n << 256n, minProfit: 1n, maxBlock: 9n, hops: [randHop()] };
  let expect: unknown;
  try { expect = { data: encodeExecuteRaw(trade) }; } catch (e) { expect = { throws: String((e as Error).message).slice(0, 120) }; }
  raw.push({ name: 'raw amount over uint256', lender: null, flashPool: null, trade: { token: trade.token, amountIn: trade.amountIn.toString(), minProfit: '1', maxBlock: '9', hops: trade.hops.map(hopJson) }, expect });
}

// ---------------------------------------------------------------------------
// 3. usdToTokenUnits: the float rounding itself, thousands of cases.
// ---------------------------------------------------------------------------
const units: unknown[] = [];
const specials = [0, -0, -1, 1e-320, 5e-324, 1e-9, 0.1, 0.3, 1, 1.5, 2.5, 1e6, 1e15, 2 ** 53, 2 ** 53 + 2, 1e21, 1e30, 1e60, 1e100, 1e299, 1e300, 1.7976931348623157e308, NaN, Infinity, -Infinity];
const unitCase = (usd: number, price: number, dec: number) => {
  let out: string;
  try { out = usdToTokenUnits(usd, price, dec).toString(); } catch { out = 'throws'; }
  units.push([bits(usd), bits(price), dec, out]);
};
for (const u of specials) for (const p of specials) unitCase(u, p, pick([0, 6, 9, 18]));
for (let i = 0; i < 4000; i++) {
  const usd = Math.exp(rnd() * 60 - 30) * (rnd() < 0.05 ? -1 : 1);
  const price = Math.exp(rnd() * 80 - 40);
  unitCase(usd, price, Math.floor(rnd() * 40));
}
// Values right at integer boundaries after * 1e9.
for (let i = 0; i < 500; i++) {
  const n = Math.floor(rnd() * 1e6);
  unitCase(n / 1e9 * 3, 3, pick([6, 9, 18]));
  unitCase((n + 0.5) / 1e9, 1, pick([0, 8, 18]));
}

// ---------------------------------------------------------------------------
// 4. pickV3Lender: filters + ordering (fee, then liquidity, stable).
// ---------------------------------------------------------------------------
const lenders: unknown[] = [];
for (let i = 0; i < 150; i++) {
  const n = Math.floor(rnd() * 8);
  const pools: PoolState[] = [];
  for (let k = 0; k < n; k++) {
    const dex = pick(['uniswap-v3', 'PancakeSwap-V3', 'ramses-v3', 'sushiswap-v3', 'uniswap-v2', 'giga-cl']);
    const type = pick(['v3', 'v3', 'v3', 'v2'] as const);
    const tok = pick([[WETH, USDC], [USDC, WETH], [TSLA, USDC], [WETH, TSLA]]);
    const liq = pick([undefined, 0n, 1n, 10n ** 18n, 10n ** 18n, BigInt(Math.floor(rnd() * 1e9))]);
    pools.push(pool(dex, type, randAddr(), tok[0], tok[1], pick([1, 5, 5, 30, 100]), { liquidity: liq }));
  }
  const token = pick([WETH, USDC, getAddress(TSLA)]);
  const exclude = pools.length && rnd() < 0.4 ? [pools[0]!.poolAddress.toUpperCase().replace('0X', '0x')] : [];
  const denied = new Set(pools.filter(() => rnd() < 0.2).map((p) => p.poolAddress.toLowerCase()));
  const useCanLend = rnd() < 0.5;
  const got = pickV3Lender(pools, token, exclude, useCanLend ? (p) => !denied.has(p.toLowerCase()) : undefined);
  lenders.push({
    name: `lender ${i}`, token, exclude, pools: pools.map(poolJson),
    denied: useCanLend ? [...denied] : null,
    expect: got ? got.poolAddress : null,
  });
}

writeFileSync(join(OUT_DIR, 'calldata.json'), JSON.stringify({
  note: 'GENERATED by sim/tests/vectors/gen-calldata-vectors.ts from src/execution/executorCalldata.ts. Do not edit by hand.',
  build: cases.map(buildCaseJson), raw, units, lenders,
}) + "\n");

// ---------------------------------------------------------------------------
// 5. Signed transactions (ethers Wallet.signTransaction, exactly the fields
//    fastSender.ts uses: type 2, chain 4663, value 0, tip 0).
// ---------------------------------------------------------------------------
const KEYS = [
  '0x0000000000000000000000000000000000000000000000000000000000000001',
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // well-known test key (anvil #0)
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // anvil #1
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140', // n - 1
];
async function txVectors() {
  const out: unknown[] = [];
  const datas = ['0x', '0x00', '0x7f', '0x80', '0x' + 'ab'.repeat(55), '0x' + 'cd'.repeat(56), '0x' + 'ef'.repeat(772), '0x' + '01'.repeat(5000)];
  // A real execute() calldata as a data case too.
  const sample = buildExecuteCall(baseIn(P.v2, P.v3));
  if (sample.ok) datas.push(sample.data);
  const nonces = [0, 1, 127, 128, 255, 256, 65_535, 1_000_000, 2 ** 40];
  const fees = [0n, 1n, 20_000_001n, 2n * 10_000_000n + 1n, 10n ** 18n, (1n << 128n) - 1n];
  const limits = [21_000n, 1_500_000n, 2_250_000n + 123_456n, (1n << 63n) - 1n];
  for (let i = 0; i < 120; i++) {
    const key = KEYS[i % KEYS.length]!;
    const w = new Wallet(key);
    const tx = {
      type: 2, chainId: i % 17 === 0 ? 1 : 4663, nonce: pick(nonces), to: randAddr(), data: pick(datas), value: 0n,
      gasLimit: pick(limits), maxFeePerGas: pick(fees), maxPriorityFeePerGas: 0n,
    };
    const raw = await w.signTransaction(tx);
    const parsed = Transaction.from(raw);
    out.push({
      name: `tx ${i}`, key, from: w.address, chainId: tx.chainId, nonce: tx.nonce, to: tx.to, data: tx.data,
      gasLimit: tx.gasLimit.toString(), maxFeePerGas: tx.maxFeePerGas.toString(), maxPriorityFeePerGas: '0',
      raw, hash: parsed.hash,
    });
  }
  writeFileSync(join(OUT_DIR, 'tx.json'), JSON.stringify({
    note: 'GENERATED by sim/tests/vectors/gen-calldata-vectors.ts with ethers Wallet.signTransaction. Test keys only.',
    txs: out,
  }) + "\n");
}

txVectors().then(() => {
  console.log(`wrote ${cases.length} build cases, ${raw.length} raw encodes, ${units.length} unit cases, ${lenders.length} lender picks, tx vectors`);
}).catch((e) => { console.error(e); process.exit(1); });
