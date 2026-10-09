// Tests for Uniswap V4 asked PER PAIR in the chain-wide scan
// (core/v4Lookup.ts + step 5 of scanUniverse in core/universeScan.ts).
//
// What must hold:
//   - pool ids match the pair watcher's own V4 ids (same pools get watched);
//   - a pair with real money on ONE exchange plus a V4 pool becomes a
//     candidate for the watch list;
//   - only pairs with money are asked about, nothing about V4 is stored in
//     the saved map, a V4 failure never fails the scan, and without the
//     option no V4 call is made at all.
import { ethers } from 'ethers';
import { v4Id, v4Asks, v4Virtual, findV4Pools, SEL_V4_LIQ, SEL_V4_SLOT0, V4_TIERS } from '../core/v4Lookup';
import { v4PoolId, STANDARD_V4_FEE_TIERS } from '../core/poolResolver';
import { scanUniverse, emptyScanState, stateToPools, type ScanFactory } from '../core/universeScan';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
// Realistic-looking addresses (the scanner ignores ones that look like small numbers).
const A = (n: number) => '0x' + 'c0ffee11' + n.toString(16).padStart(32, '0');
const lc = (a: string) => a.toLowerCase();
const coder = ethers.AbiCoder.defaultAbiCoder();
const Q96 = 2n ** 96n;
const E18 = 10n ** 18n, E6 = 10n ** 6n;
const enc = (x: bigint) => '0x' + x.toString(16).padStart(64, '0');
const ZERO = ethers.ZeroAddress;

const USDG = A(0x1001), WETH = A(0x1002), HOOD = A(0x1003), JUNK = A(0x1004), TSLA = A(0x1005);
const SV = A(0x2002), PM = A(0x2001), V2F = A(0x2003);

async function main() {
  // -------------------------------------------------------------------------
  // 1) Ids, asks, virtual amounts.
  // -------------------------------------------------------------------------
  const [c0, c1] = lc(USDG) < lc(HOOD) ? [USDG, HOOD] : [HOOD, USDG];
  assert(v4Id(c0, c1, 3000, 60) === lc(v4PoolId(c0, c1, 3000, 60)), 'pool id matches the pair watcher\'s own V4 id');
  assert(JSON.stringify(V4_TIERS) === JSON.stringify(STANDARD_V4_FEE_TIERS), 'same fee tiers as the pair watcher');
  const usdgAsks = v4Asks([{ quote: USDG, other: HOOD }], WETH);
  assert(usdgAsks.length === 4 && usdgAsks.every((a) => !a.native), 'USDG pair: the 4 standard tiers');
  const wethAsks = v4Asks([{ quote: WETH, other: HOOD }], WETH);
  assert(wethAsks.length === 8 && wethAsks.filter((a) => a.native && a.c0 === lc(ZERO)).length === 4, 'WETH pair: + 4 native-ETH versions');
  const v = v4Virtual(2n * Q96, 1000n * E18);
  assert(v.a0 === 500n * E18 && v.a1 === 2000n * E18, 'virtual amounts at price 4');

  // -------------------------------------------------------------------------
  // 2) findV4Pools: only pools with liquidity get a price read; valued as
  //    2 x the USDG/WETH side; under the minimum dropped.
  // -------------------------------------------------------------------------
  // HOOD/USDG at $100: if USDG is c0 (6 dec) and HOOD c1 (18 dec), price of
  // c1 in c0 raw = 1e18 per 100e6 -> sqrt(1e18/1e8).
  const sqrtOf = (raw: number) => BigInt(Math.round(Math.sqrt(raw) * 2 ** 48)) * (2n ** 48n);
  const hoodRaw = lc(c0) === lc(USDG) ? 1e18 / 100e6 : 100e6 / 1e18;
  const hoodSq = sqrtOf(hoodRaw);
  const hoodL = BigInt(Math.round(Math.sqrt(20_000e6 * 200e18))); // ~$20k each side
  const deepId = v4Id(c0, c1, 3000, 60), thinId = v4Id(c0, c1, 500, 10);
  const asked: string[] = [];
  const sv = async (calls: { target: string; data: string }[]) => calls.map((c) => {
    asked.push(c.data.slice(0, 10));
    const id = '0x' + c.data.slice(10);
    if (c.data.startsWith(SEL_V4_LIQ)) return enc(id === deepId ? hoodL : id === thinId ? 10n ** 6n : 0n);
    if (c.data.startsWith(SEL_V4_SLOT0)) return enc(hoodSq) + '0'.repeat(192);
    return null;
  });
  const found = await findV4Pools(sv, usdgAsks, { stateView: SV, poolManager: PM, weth: WETH, quoteUsd: (q) => (q === lc(USDG) ? 1 : 3000), quoteDecimals: (q) => (q === lc(USDG) ? 6 : 18), minUsd: 2_000 });
  assert(found.length === 1 && found[0].pool === deepId && found[0].kind === 'v4', 'only the deep V4 pool kept (thin one under $2k dropped)');
  assert((found[0].usd ?? 0) > 30_000 && (found[0].usd ?? 0) < 50_000, `valued at ~$40k (got $${Math.round(found[0].usd ?? 0)})`);
  assert(asked.filter((s) => s === SEL_V4_SLOT0).length === 2, 'price read only for the 2 pools with liquidity (not all 4)');
  assert(found[0].v4?.fee === 3000 && found[0].v4?.stateView === lc(SV), 'found pool carries its fee and where to read it');

  // Native ETH pool: quote (WETH) is currency0 via native ETH.
  const ethHood = v4Asks([{ quote: WETH, other: HOOD }], WETH).find((a) => a.native && a.fee === 3000)!;
  const ethSq = sqrtOf(30); // 30 HOOD per ETH (both 18 decimals)
  const ethL = BigInt(Math.round(Math.sqrt(6.67e18 * 200e18)));
  const ethFound = await findV4Pools(async (calls) => calls.map((c) => {
    const id = '0x' + c.data.slice(10);
    if (c.data.startsWith(SEL_V4_LIQ)) return enc(id === ethHood.id ? ethL : 0n);
    return enc(ethSq) + '0'.repeat(192);
  }), wethAsks, { stateView: SV, poolManager: PM, weth: WETH, quoteUsd: (q) => (q === lc(WETH) ? 3000 : 1), quoteDecimals: () => 18, minUsd: 2_000 });
  assert(ethFound.length === 1 && ethFound[0].v4?.native === true && ethFound[0].token0 === lc(WETH), 'native ETH pool found; WETH stands in for ETH');
  assert((ethFound[0].usd ?? 0) > 30_000 && (ethFound[0].usd ?? 0) < 50_000, `native pool valued from its ETH side (~$40k, got $${Math.round(ethFound[0].usd ?? 0)})`);

  // -------------------------------------------------------------------------
  // 3) The full scan on a fake chain. HOOD/USDG has ONE pool elsewhere (V2,
  //    $100k) plus a V4 pool: it becomes a candidate. JUNK/USDG has one
  //    tiny pool: never asked about. TSLA/USDG one deep pool, no V4: not a
  //    candidate. WETH/USDG prices WETH.
  // -------------------------------------------------------------------------
  const HOOD_V2 = A(0x4001), WETH_V2 = A(0x4002), JUNK_V2 = A(0x4003), TSLA_V2 = A(0x4004), WETH_V2B = A(0x4005);
  const bal: Record<string, Record<string, bigint>> = {
    [lc(USDG)]: { [lc(HOOD_V2)]: 50_000n * E6, [lc(WETH_V2)]: 300_000n * E6, [lc(WETH_V2B)]: 30_000n * E6, [lc(JUNK_V2)]: 50n * E6, [lc(TSLA_V2)]: 40_000n * E6 },
    [lc(HOOD)]: { [lc(HOOD_V2)]: 500n * E18 },
    [lc(WETH)]: { [lc(WETH_V2)]: 100n * E18, [lc(WETH_V2B)]: 10n * E18 },
    [lc(JUNK)]: { [lc(JUNK_V2)]: 1_000_000n * E18 },
    [lc(TSLA)]: { [lc(TSLA_V2)]: 100n * E18 },
  };
  const PC = ethers.id('PairCreated(address,address,address,uint256)');
  const pairLog = (a: string, b: string, pair: string) => {
    const [t0, t1] = lc(a) < lc(b) ? [a, b] : [b, a];
    return { address: V2F, topics: [PC, ethers.zeroPadValue(t0, 32), ethers.zeroPadValue(t1, 32)], data: coder.encode(['address', 'uint256'], [pair, 1]) };
  };
  const targets: string[] = [];
  const v4Asked: string[] = [];
  let v4Breaks = false;
  const provider = {
    getBlockNumber: async () => 100,
    getCode: async () => '0x', // no Multicall3: single calls
    call: async ({ to, data }: { to: string; data: string }) => {
      targets.push(to);
      const t = lc(to), sel = data.slice(0, 10);
      if (sel === '0x70a08231') return enc(bal[t]?.['0x' + data.slice(-40)] ?? 0n);
      if (sel === '0x313ce567') return enc(t === lc(USDG) ? 6n : 18n);
      if (sel === '0x95d89b41') return coder.encode(['string'], ['X']);
      if (t === lc(SV)) {
        if (v4Breaks) throw new Error('node down');
        const id = '0x' + data.slice(10);
        v4Asked.push(id);
        if (sel === SEL_V4_LIQ) return enc(id === deepId ? hoodL : 0n);
        if (sel === SEL_V4_SLOT0) return enc(hoodSq) + '0'.repeat(192);
      }
      const e: any = new Error('revert'); e.code = 'CALL_EXCEPTION'; throw e;
    },
    send: async (_m: string, [f]: any[]) => (lc(String(f.address)) === lc(V2F) ? [pairLog(HOOD, USDG, HOOD_V2), pairLog(WETH, USDG, WETH_V2), pairLog(WETH, USDG, WETH_V2B), pairLog(JUNK, USDG, JUNK_V2), pairLog(TSLA, USDG, TSLA_V2)] : []),
  } as unknown as ethers.JsonRpcProvider;
  const v2: ScanFactory = { dex: 'uniswap-v2', kind: 'v2', factory: V2F };
  const opts = { usdToken: USDG, wrappedNative: WETH, minPoolUsd: 2_000, v4: { stateView: SV, poolManager: PM, pauseMs: 0 } };

  const st = emptyScanState();
  const res = await scanUniverse(provider, [v2], opts, st);
  const hoodC = res.candidates.find((c) => [c.tokenA, c.tokenB].map(lc).includes(lc(HOOD)));
  assert(!!hoodC && hoodC.pools.some((p) => p.kind === 'v4') && hoodC.pools.some((p) => p.kind === 'v2'), 'HOOD/USDG (one V2 pool + a V4 pool) is now a candidate for the watch list');
  assert(!res.candidates.some((c) => [c.tokenA, c.tokenB].map(lc).includes(lc(TSLA))), 'TSLA/USDG (one pool, no V4 pool) is still not a candidate');
  assert(!!res.v4 && res.v4.withMoney === 2 && res.v4.found === 1 && res.v4.candidatesWithV4 === 1, `counts: 2 single pairs with money (HOOD, TSLA), 1 V4 pool found (got ${JSON.stringify(res.v4)})`);
  const junkIds = new Set(v4Asks([{ quote: USDG, other: JUNK }], WETH).map((a) => a.id));
  assert(!v4Asked.some((id) => junkIds.has(id)), 'JUNK ($100 pool) never asked about on V4');
  assert(targets.every((t) => t.length === 42), 'every call targets a real address (never a V4 pool id)');
  assert(!stateToPools(st).some((p) => p.kind === 'v4') && !('v4' in st) && st.factories.every((f) => !f.includes('|v4|')), 'nothing about V4 is stored in the saved map');
  assert(res.candidates.some((c) => [c.tokenA, c.tokenB].map(lc).includes(lc(WETH))), 'normal candidates still there (WETH/USDG on 2 pools)');

  // V4 failure: the scan still works, the error is noted.
  v4Breaks = true;
  const res2 = await scanUniverse(provider, [v2], opts, emptyScanState());
  assert(res2.candidates.length >= 1 && res2.errors.some((e) => /uniswap-v4 lookup/.test(e)) && !res2.v4, 'V4 failure: scan still returns its candidates, error noted');
  v4Breaks = false;

  // Option left out: no V4 call at all.
  v4Asked.length = 0;
  const res3 = await scanUniverse(provider, [v2], { usdToken: USDG, wrappedNative: WETH, minPoolUsd: 2_000 }, emptyScanState());
  assert(v4Asked.length === 0 && !res3.v4, 'without the V4 option: no V4 call at all');
}
main();
