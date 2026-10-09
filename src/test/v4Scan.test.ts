// Tests for Uniswap V4 in the chain-wide scan (core/v4Scan.ts) and in
// everything built on the scan's map: the pair picker (scanUniverse), the
// coin groups (tokenGroups), the loop watch and the market-open watch
// (crossQuoteMonitor), and the new pool counter (newPoolWatch).
//
// The key thing to prove: V4 pools have no address (just a 32-byte id), so
// nothing may ever send them a normal pool call (balanceOf(pool), fee(),
// getReserves()); they must be read through StateView instead.
import { ethers } from 'ethers';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  V4_INITIALIZE_TOPIC, V4_MODIFY_LIQUIDITY_TOPIC, SEL_V4_SLOT0, SEL_V4_LIQ,
  decodeV4Initialize, decodeV4ModifyLiquidity, v4IdOf, v4VirtualAmounts, v4MintAmounts, readSideAmounts, v4PoolState,
} from '../core/v4Scan';
import { scanUniverse, emptyScanState, stateToPools, addPoolsToState, derivePrices, pruneV4, type ScannedPool, type ScanFactory } from '../core/universeScan';
import { buildTokenGroups } from '../core/tokenGroups';
import { LoopMonitor, CrossQuoteMonitor } from '../core/crossQuoteMonitor';
import { NewPoolWatch } from '../core/newPoolWatch';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
// Realistic-looking addresses (the scanner ignores ones that look like small numbers).
const A = (n: number) => '0x' + 'c0ffee11' + n.toString(16).padStart(32, '0');
const coder = ethers.AbiCoder.defaultAbiCoder();
const Q96 = 2n ** 96n;
const E18 = 10n ** 18n, E6 = 10n ** 6n;
const ZERO = '0x' + '0'.repeat(40);

const USDG = A(0x1001), WETH = A(0x1002), HOOD = A(0x1003), JUNK = A(0x1004);
const PM = A(0x2001), SV = A(0x2002), V2F = A(0x2003);
const v4f: ScanFactory = { dex: 'uniswap-v4', kind: 'v4', factory: PM, stateView: SV, weth: WETH };

// An Initialize log as the PoolManager emits it.
function initLog(c0: string, c1: string, fee: number, ts: number, hooks: string, sqrtPriceX96: bigint, block = 10, idOverride?: string) {
  const id = idOverride ?? v4IdOf(c0, c1, fee, ts, hooks);
  return {
    address: PM, blockNumber: ethers.toQuantity(block), logIndex: '0x0',
    topics: [V4_INITIALIZE_TOPIC, id, ethers.zeroPadValue(c0, 32), ethers.zeroPadValue(c1, 32)],
    data: coder.encode(['uint24', 'int24', 'address', 'uint160', 'int24'], [fee, ts, hooks, sqrtPriceX96, -5]),
  };
}
function modifyLog(id: string, tickLower: number, tickUpper: number, delta: bigint, block = 11) {
  return {
    address: PM, blockNumber: ethers.toQuantity(block), logIndex: '0x1',
    topics: [V4_MODIFY_LIQUIDITY_TOPIC, id, ethers.zeroPadValue(A(0x99), 32)],
    data: coder.encode(['int24', 'int24', 'int256', 'bytes32'], [tickLower, tickUpper, delta, ethers.ZeroHash]),
  };
}
// sqrtPriceX96 for "price of token1 in token0 raw units".
const sqrtOf = (rawPrice: number) => BigInt(Math.round(Math.sqrt(rawPrice) * 2 ** 48)) * (2n ** 48n);

async function main() {
  // -------------------------------------------------------------------------
  // 1) Decoding Initialize: the id self-check, native ETH, hooks.
  // -------------------------------------------------------------------------
  const sq1 = Q96; // price 1
  const plain = decodeV4Initialize(initLog(USDG, HOOD, 3000, 60, ZERO, sq1), WETH);
  assert(!!plain && plain.token0 === USDG.toLowerCase() && plain.token1 === HOOD.toLowerCase() && plain.fee === 3000 && plain.tickSpacing === 60 && !plain.native && !plain.hooked, 'Initialize decoded: coins, fee, tick spacing');
  const nat = decodeV4Initialize(initLog(ZERO, HOOD, 500, 10, ZERO, sq1), WETH);
  assert(!!nat && nat.native && nat.token0 === WETH.toLowerCase(), 'native ETH pool: WETH stands in for ETH');
  const hooked = decodeV4Initialize(initLog(USDG, HOOD, 3000, 60, A(0xabc), sq1), WETH);
  assert(!!hooked && hooked.hooked, 'hooked pool is flagged (callers skip it)');
  assert(decodeV4Initialize(initLog(USDG, HOOD, 3000, 60, ZERO, sq1, 10, ethers.ZeroHash), WETH) === null, 'id that does not match the key: rejected (proves the layout is read right)');
  assert(decodeV4Initialize(initLog(ZERO, WETH, 100, 1, ZERO, sq1), WETH) === null, 'native ETH vs WETH pool: not a coin pair');
  const negTs = decodeV4Initialize(initLog(USDG, HOOD, 10000, 200, ZERO, sq1), WETH);
  assert(!!negTs && negTs.tickSpacing === 200, 'tick spacing 200 read correctly');

  // -------------------------------------------------------------------------
  // 2) Virtual amounts, mint amounts, ModifyLiquidity decoding.
  // -------------------------------------------------------------------------
  const L = 1000n * E18;
  const v1 = v4VirtualAmounts(Q96, L);
  assert(v1.a0 === L && v1.a1 === L, 'price 1: both sides = liquidity');
  const v4x = v4VirtualAmounts(2n * Q96, L);
  assert(v4x.a0 === L / 2n && v4x.a1 === 2n * L, 'price 4: amount0 = L/2, amount1 = 2L');
  assert(v4VirtualAmounts(0n, L).a0 === 0n && v4VirtualAmounts(Q96, 0n).a1 === 0n, 'empty pool: zero');
  const m = decodeV4ModifyLiquidity(modifyLog('0x' + 'ab'.repeat(32), -600, 600, 5n * E18));
  assert(!!m && m.tickLower === -600 && m.tickUpper === 600 && m.liquidityDelta === 5n * E18, 'ModifyLiquidity decoded (negative tick too)');
  const neg = decodeV4ModifyLiquidity(modifyLog('0x' + 'ab'.repeat(32), -600, 600, -5n * E18));
  assert(!!neg && neg.liquidityDelta < 0n, 'liquidity removal decoded as negative');
  const mint = v4MintAmounts(Q96, -600, 600, 1_000_000n);
  assert(Math.abs(mint.a0 - mint.a1) / mint.a0 < 1e-9 && mint.a0 > 0, 'mint at price 1 in a symmetric range: equal amounts');
  const above = v4MintAmounts(Q96, 600, 1200, 1_000_000n);
  assert(above.a0 > 0 && above.a1 === 0, 'range above the price: only coin0 goes in');

  // -------------------------------------------------------------------------
  // 3) readSideAmounts: ordinary pools use balanceOf, V4 uses StateView.
  // -------------------------------------------------------------------------
  const id = v4IdOf(USDG, HOOD, 3000, 60, ZERO);
  const sent: { target: string; data: string }[] = [];
  const res = await readSideAmounts(async (calls) => { sent.push(...calls); return calls.map((c) => {
    if (c.data.startsWith(SEL_V4_SLOT0)) return '0x' + (2n * Q96).toString(16).padStart(64, '0') + '0'.repeat(192);
    if (c.data.startsWith(SEL_V4_LIQ)) return '0x' + L.toString(16).padStart(64, '0');
    return '0x' + (777n).toString(16).padStart(64, '0');
  }); }, [
    { pool: A(0x3001), token0: USDG, token: USDG },
    { pool: id, token0: USDG, token: USDG, v4StateView: SV },
    { pool: id, token0: USDG, token: HOOD, v4StateView: SV },
  ]);
  assert(res[0] === 777n && res[1] === L / 2n && res[2] === 2n * L, 'mixed reads: balance for ordinary pool, virtual amounts for V4');
  assert(sent.every((c) => c.target.length === 42), 'every call targets a real address (never a V4 pool id)');

  // -------------------------------------------------------------------------
  // 4) Scan state: V4 details survive save/load; old state without them is safe.
  // -------------------------------------------------------------------------
  const st = emptyScanState();
  const v4p: ScannedPool = { dex: 'uniswap-v4', kind: 'v4', pool: id, token0: USDG.toLowerCase(), token1: HOOD.toLowerCase(), v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: PM.toLowerCase(), stateView: SV.toLowerCase() } };
  addPoolsToState(st, v4f, [v4p]);
  const back = stateToPools(JSON.parse(JSON.stringify(st)));
  assert(back.length === 1 && back[0].kind === 'v4' && back[0].v4?.fee === 3000 && back[0].v4?.stateView === SV.toLowerCase() && back[0].v4?.poolManager === PM.toLowerCase(), 'V4 pool round-trips through the saved scan state');
  const old = JSON.parse(JSON.stringify(st)); delete old.v4;
  assert(stateToPools(old).length === 0, 'V4 pool without its details (old state): dropped, never half-read');
  // V4 pools are never used to PRICE a coin (concentrated, like V3).
  const priced = derivePrices([{ ...v4p, bal0: 5000n * E6, bal1: 1n * E18 }], new Map([[USDG.toLowerCase(), 6], [HOOD.toLowerCase(), 18]]), USDG, WETH);
  assert(!priced.has(HOOD.toLowerCase()), 'a V4 pool alone never sets a coin price');

  // -------------------------------------------------------------------------
  // 5) The full scan on a fake chain: a pair with one V2 pool and one V4
  //    pool. Before V4, the pair had ONE visible pool and was never picked.
  // -------------------------------------------------------------------------
  // HOOD = $100. V2 HOOD/USDG pool: 500 HOOD + 50,000 USDG. V2 WETH/USDG
  // pool prices WETH. V4 HOOD/USDG (native? no) with ~$40k virtual depth.
  const HOOD_V2 = A(0x4001), WETH_V2 = A(0x4002);
  const [c0, c1] = USDG.toLowerCase() < HOOD.toLowerCase() ? [USDG, HOOD] : [HOOD, USDG];
  // raw price of c1 in c0: if c0 = USDG(6) and c1 = HOOD(18): 1 HOOD raw unit = 100e6/1e18 USDG raw
  const rawPx = c0 === USDG ? 100e6 / 1e18 : 1e18 / 100e6;
  const hoodSq = sqrtOf(1 / rawPx); // sqrtPrice = sqrt(token1 per token0)
  const hoodL = BigInt(Math.round(Math.sqrt(20_000e6 * 200e18))); // ~$20k each side
  const hoodId = v4IdOf(c0, c1, 3000, 60, ZERO);
  const junkHookedId = v4IdOf(USDG, JUNK, 3000, 60, A(0xabc));
  const balances: Record<string, Record<string, bigint>> = {
    [USDG.toLowerCase()]: { [HOOD_V2.toLowerCase()]: 50_000n * E6, [WETH_V2.toLowerCase()]: 300_000n * E6 },
    [HOOD.toLowerCase()]: { [HOOD_V2.toLowerCase()]: 500n * E18 },
    [WETH.toLowerCase()]: { [WETH_V2.toLowerCase()]: 100n * E18 },
  };
  const getLogsAsked: any[] = [];
  const provider = {
    getBlockNumber: async () => 100,
    getCode: async () => '0x',  // no Multicall3: single calls (simpler fake)
    call: async ({ to, data }: { to: string; data: string }) => {
      if (to.length !== 42) throw new Error('call to a non-address: ' + to);
      const t = to.toLowerCase();
      const sel = data.slice(0, 10);
      const enc = (x: bigint) => '0x' + x.toString(16).padStart(64, '0');
      if (sel === '0x70a08231') return enc(balances[t]?.['0x' + data.slice(-40)] ?? 0n);
      if (sel === '0x313ce567') return enc(t === USDG.toLowerCase() ? 6n : 18n);
      if (sel === '0x95d89b41') return coder.encode(['string'], [t === HOOD.toLowerCase() ? 'HOOD' : t === USDG.toLowerCase() ? 'USDG' : 'WETH']);
      if (t === SV.toLowerCase() && sel === SEL_V4_SLOT0) return enc(hoodSq) + '0'.repeat(192);
      if (t === SV.toLowerCase() && sel === SEL_V4_LIQ) return enc(hoodL);
      const e: any = new Error('revert'); e.code = 'CALL_EXCEPTION'; throw e;
    },
    send: async (method: string, params: any[]) => {
      if (method !== 'eth_getLogs') throw new Error('unexpected ' + method);
      const f = params[0];
      getLogsAsked.push(f);
      const addr = String(f.address).toLowerCase();
      if (addr === PM.toLowerCase()) return [initLog(c0, c1, 3000, 60, ZERO, hoodSq), initLog(USDG, JUNK, 3000, 60, A(0xabc), Q96)].map((l) => ({ ...l, data: l.data }));
      if (addr === V2F.toLowerCase()) {
        const pc = (a: string, b: string, pair: string) => ({ topics: [ethers.id('PairCreated(address,address,address,uint256)'), ethers.zeroPadValue(a, 32), ethers.zeroPadValue(b, 32)], data: coder.encode(['address', 'uint256'], [pair, 1]) });
        return [pc(c0, c1, HOOD_V2), pc(WETH.toLowerCase() < USDG.toLowerCase() ? WETH : USDG, WETH.toLowerCase() < USDG.toLowerCase() ? USDG : WETH, WETH_V2)];
      }
      return [];
    },
  } as unknown as ethers.JsonRpcProvider;
  const v2f: ScanFactory = { dex: 'uniswap-v2', kind: 'v2', factory: V2F };
  const state = emptyScanState();
  const scan = await scanUniverse(provider, [v2f, v4f], { usdToken: USDG, wrappedNative: WETH, minPoolUsd: 2_000 }, state);
  const pmAsk = getLogsAsked.find((f) => String(f.address).toLowerCase() === PM.toLowerCase());
  assert(!!pmAsk && Array.isArray(pmAsk.topics) && pmAsk.topics[0] === V4_INITIALIZE_TOPIC, 'PoolManager logs are asked with the Initialize topic filter (no swap flood)');
  assert(scan.poolsPerDex['uniswap-v4'] === 1, `one V4 pool in the map, the hooked one skipped (got ${scan.poolsPerDex['uniswap-v4']})`);
  assert(!stateToPools(state).some((p) => p.pool === junkHookedId), 'hooked pool never stored');
  const hoodPair = scan.candidates.find((c) => [c.tokenA, c.tokenB].map((x) => x.toLowerCase()).includes(HOOD.toLowerCase()));
  assert(!!hoodPair && hoodPair.pools.some((p) => p.kind === 'v4') && hoodPair.pools.some((p) => p.kind === 'v2'), 'HOOD/USDG (one V2 + one V4 pool) is now picked for the watch list');
  const v4usd = hoodPair?.pools.find((p) => p.kind === 'v4')?.usd ?? 0;
  assert(v4usd > 30_000 && v4usd < 50_000, `V4 pool valued from its virtual amounts (~$40k, got $${Math.round(v4usd)})`);

  // -------------------------------------------------------------------------
  // 6) Coin groups: a coin whose real money is on V4 is verified, and the
  //    build never sends a normal pool call to a V4 id.
  // -------------------------------------------------------------------------
  const scanned = stateToPools(state);
  const USDT = A(0x1005);
  const [u0, u1] = USDG.toLowerCase() < USDT.toLowerCase() ? [USDG, USDT] : [USDT, USDG];
  const usdtId = v4IdOf(u0, u1, 100, 1, ZERO);
  const usdtPool: ScannedPool = { dex: 'uniswap-v4', kind: 'v4', pool: usdtId, token0: u0.toLowerCase(), token1: u1.toLowerCase(), v4: { fee: 100, tickSpacing: 1, native: false, poolManager: PM.toLowerCase(), stateView: SV.toLowerCase() } };
  const gPools = [...scanned, usdtPool];
  const gState = { ...state, tokens: [...state.tokens, USDT.toLowerCase()] };
  // ETH/HOOD V4 pool (native ETH): 30 HOOD per ETH, ~$20k each side.
  const hoodEthId = v4IdOf(ZERO, HOOD, 500, 10, ZERO);
  const hoodEthSq = sqrtOf(30);
  const hoodEthL = BigInt(Math.round(Math.sqrt(6.67e18 * 200e18)));
  const groupCalls: string[] = [];
  const usdtL = 1_000_000n * E6; // price 1 (both 6 decimals): $1M each side
  const groupsCallMany = async (calls: { target: string; data: string }[]) => {
    groupCalls.push(...calls.map((c) => c.target));
    return calls.map((c) => {
      const t = c.target.toLowerCase(), sel = c.data.slice(0, 10);
      const enc = (x: bigint) => '0x' + x.toString(16).padStart(64, '0');
      if (sel === '0x95d89b41') return coder.encode(['string'], [t === USDT.toLowerCase() ? 'USDT' : t === HOOD.toLowerCase() ? 'HOOD' : t === USDG.toLowerCase() ? 'USDG' : 'WETH']);
      if (sel === '0x313ce567') return enc(t === USDG.toLowerCase() || t === USDT.toLowerCase() ? 6n : 18n);
      if (sel === '0x70a08231') return enc(balances[t]?.['0x' + c.data.slice(-40)] ?? 0n);
      if (sel === '0x0902f1ac') {
        if (t === WETH_V2.toLowerCase()) { const w = WETH.toLowerCase() < USDG.toLowerCase(); return enc(w ? 100n * E18 : 300_000n * E6) + enc(w ? 300_000n * E6 : 100n * E18) + enc(0n); }
        return null;
      }
      const isId = (x: string) => c.data.includes(x.slice(2));
      if (t === SV.toLowerCase() && sel === SEL_V4_SLOT0) return enc(isId(usdtId) ? Q96 : isId(hoodEthId) ? hoodEthSq : hoodSq) + '0'.repeat(192);
      if (t === SV.toLowerCase() && sel === SEL_V4_LIQ) return enc(isId(usdtId) ? usdtL : isId(hoodEthId) ? hoodEthL : hoodL);
      return null;
    });
  };
  const dir = mkdtempSync(join(tmpdir(), 'v4groups-'));
  const g = await buildTokenGroups({ callMany: groupsCallMany, state: gState as any, pools: gPools, usdg: USDG, weth: WETH, symbolCacheFile: join(dir, 's.json'), outFile: join(dir, 'g.json'), pauseMs: 0 });
  assert(g.members.some((x) => x.token === USDT.toLowerCase() && x.group === 'Dollars'), 'USDT with its money only on V4 is verified as a dollar coin');
  assert(groupCalls.every((t) => t.length === 42), 'coin group build never calls a V4 pool id directly');

  // -------------------------------------------------------------------------
  // 7) Loop watch and market-open watch: V4 legs are proper V4 records, fees
  //    come from the pool key, and no call ever targets a V4 id.
  // -------------------------------------------------------------------------
  const monCalls: string[] = [];
  const monCallMany = async (calls: { target: string; data: string }[]) => { monCalls.push(...calls.map((c) => c.target)); return groupsCallMany(calls); };
  const loop = new LoopMonitor(monCallMany, () => 1_000);
  const n = await loop.setup(gPools, [
    { token: USDG, symbol: 'USDG', group: 'Dollars', priceUsd: 1 },
    { token: USDT, symbol: 'USDT', group: 'Dollars', priceUsd: 1 },
    { token: WETH, symbol: 'WETH', group: 'ETH', priceUsd: 3000 },
  ], 80, 1_000);
  assert(n >= 0 && monCalls.every((t) => t.length === 42), 'loop watch setup: no call ever targets a V4 id');
  await loop.tick();
  assert(monCalls.every((t) => t.length === 42), 'loop watch reading round: V4 pools read through StateView only');

  const cq = new CrossQuoteMonitor(monCallMany, USDG, WETH, () => 3000);
  // HOOD has a USDG pool on V2 + V4, and needs a WETH pool to qualify: add one on V4 (native ETH).
  const hoodEth: ScannedPool = { dex: 'uniswap-v4', kind: 'v4', pool: hoodEthId, token0: WETH.toLowerCase(), token1: HOOD.toLowerCase(), v4: { fee: 500, tickSpacing: 10, native: true, poolManager: PM.toLowerCase(), stateView: SV.toLowerCase() } };
  const got = await cq.setup([...scanned, hoodEth], 60, 1_000);
  assert(got === 1, `market-open watch picks HOOD using its V4 pools (got ${got})`);
  const legs = (cq as any).legs.get(HOOD.toLowerCase()) as { pool: any; feePct: number; feeKnown: boolean }[];
  const v4leg = legs?.find((l) => l.pool.v4);
  assert(!!v4leg && v4leg.pool.poolType === 'v3' && v4leg.feeKnown && v4leg.pool.v4.stateView.toLowerCase() === SV.toLowerCase(), 'V4 leg: a real V4 record with its known fee');
  assert(monCalls.every((t) => t.length === 42), 'market-open watch: no call ever targets a V4 id');
  const ps = v4PoolState({ dex: 'uniswap-v4', pool: hoodEthId, token0: WETH, token1: HOOD, v4: hoodEth.v4! });
  assert(ps.v4?.native === true && ps.feePips === 500 && ps.tokenA === WETH, 'V4 record matches the pair watcher\'s shape (native flag, fee in pips)');

  // -------------------------------------------------------------------------
  // 8) New pool counter: a V4 pool for deep coins, created 2% off, funded.
  // -------------------------------------------------------------------------
  let latest = 100;
  let v4Logs: any[] = [];
  const asked: { addrs: string[]; topics?: any }[] = [];
  const npw = new NewPoolWatch({
    factories: [v2f, v4f],
    getLogs: async (addrs, _f, _t, topics) => { asked.push({ addrs, topics }); return topics ? v4Logs : []; },
    latestBlock: async () => latest,
    refPrice: (t) => (t === HOOD.toLowerCase() ? { px: 100, depthUsd: 50_000, pool: null } : t === USDG.toLowerCase() ? { px: 1, depthUsd: 1e9, pool: null } : null),
    decimals: (t) => (t === USDG.toLowerCase() ? 6 : 18), symbol: (t) => (t === HOOD.toLowerCase() ? 'HOOD' : 'USDG'),
    now: () => 5_000, log: () => {},
  });
  await npw.poll(); // first poll: just notes the block
  // Creator sets HOOD at $102 (2% off the deep $100).
  const off = c0 === USDG ? 102e6 / 1e18 : 1e18 / 102e6;
  const offSq = sqrtOf(1 / off);
  const newId = v4IdOf(c0, c1, 10000, 200, ZERO);
  v4Logs = [initLog(c0, c1, 10000, 200, ZERO, offSq, 101), modifyLog(newId, -887200, 887200, 10n ** 15n, 101)];
  latest = 101;
  await npw.poll();
  const s = npw.summary(0);
  assert(asked.some((x) => x.topics && x.addrs[0] === PM), 'V4 events asked from the PoolManager with a topic filter');
  assert(asked.every((x) => x.addrs.every((a) => a.length === 42)), 'never asks logs for a V4 id as if it were an address');
  assert(s.created === 1 && s.eligible === 1 && s.measured === 1, `V4 pool for deep coins counted and measured (created ${s.created}, measured ${s.measured})`);
  assert(s.top[0] && Math.abs(s.top[0].gapPct - 2) < 0.1, `starting price 2% off detected (got ${s.top[0]?.gapPct.toFixed(2)}%)`);
}

// ---------------------------------------------------------------------------
// 9) The V4 FILTER (Oct 9): keeping all ~650,000 V4 pools ran the bot out of
//    memory. Only pools whose coins both trade elsewhere are kept, under a
//    hard ceiling; old unfiltered saved maps are cleaned; once a day V4's
//    history is re-read so coins that list elsewhere later get picked up.
// ---------------------------------------------------------------------------
async function filterTests() {
  const X1 = A(0x5001), ONLY1 = A(0x5002), ONLY2 = A(0x5003);
  const Y = [A(0x5101), A(0x5102), A(0x5103), A(0x5104), A(0x5105)];
  const V2F2 = A(0x2004);
  const PC = ethers.id('PairCreated(address,address,address,uint256)');
  const sortPair = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]);
  const pairLog = (a: string, b: string, pair: string, block: number) => {
    const [t0, t1] = sortPair(a, b);
    return { address: V2F2, blockNumber: ethers.toQuantity(block), logIndex: '0x0', topics: [PC, ethers.zeroPadValue(t0, 32), ethers.zeroPadValue(t1, 32)], data: coder.encode(['address', 'uint256'], [pair, 1]) };
  };
  const v4Init = (a: string, b: string, fee: number, block: number, hooks = ZERO) => { const [c0, c1] = sortPair(a, b); return initLog(c0, c1, fee, 60, hooks, Q96, block); };

  let chainLogs: any[] = [];
  let head = 100;
  const pmAsks: { from: number; to: number }[] = [];
  const provider = {
    getBlockNumber: async () => head,
    getCode: async () => '0x',
    call: async ({ data }: { data: string }) => {
      if (data.startsWith('0x313ce567')) return '0x' + (18n).toString(16).padStart(64, '0');
      if (data.startsWith('0x70a08231') || data.startsWith(SEL_V4_SLOT0) || data.startsWith(SEL_V4_LIQ)) return '0x' + '0'.repeat(64);
      const e: any = new Error('revert'); e.code = 'CALL_EXCEPTION'; throw e;
    },
    send: async (_m: string, [f]: any[]) => {
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      const addr = String(f.address).toLowerCase();
      if (addr === PM.toLowerCase()) pmAsks.push({ from, to });
      return chainLogs.filter((l) => l.address.toLowerCase() === addr && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to
        && (!f.topics || f.topics[0] === l.topics[0]));
    },
  } as unknown as ethers.JsonRpcProvider;
  const v2: ScanFactory = { dex: 'uniswap-v2', kind: 'v2', factory: V2F2 };

  // Chain: X1 and Y1..Y5 trade on V2 (vs WETH). On V4: X1/WETH (kept),
  // ONLY1/WETH and X1/ONLY2 (a coin only on V4: dropped), one hooked pool.
  chainLogs = [
    pairLog(X1, WETH, A(0x6001), 5), ...Y.map((y, i) => pairLog(y, WETH, A(0x6100 + i), 5)),
    v4Init(X1, WETH, 3000, 10), v4Init(ONLY1, WETH, 3000, 11), v4Init(X1, ONLY2, 3000, 12), v4Init(X1, WETH, 500, 13, A(0xabc)),
  ];
  let clock = 1_000_000_000;
  const lines: string[] = [];
  const st = emptyScanState();
  await scanUniverse(provider, [v4f, v2], { usdToken: USDG, wrappedNative: WETH, now: () => clock, log: (m) => lines.push(m) }, st);
  const v4in = () => stateToPools(st).filter((p) => p.kind === 'v4');
  assert(v4in().length === 1 && [v4in()[0].token0, v4in()[0].token1].includes(X1.toLowerCase()) && [v4in()[0].token0, v4in()[0].token1].includes(WETH.toLowerCase()), 'filter: only the V4 pool whose coins trade elsewhere (X1/WETH) is kept');
  assert(lines.some((l) => /uniswap-v4: \+1 pools kept, 2 skipped \(coins only on V4\), 1 with hooks skipped/.test(l)), 'log says what was kept, skipped and why');
  assert(st.v4FullAt === clock, 'first scan is a full read of V4 history (time noted)');

  // Within a day: only new blocks are read.
  head = 120; clock += 3600_000; pmAsks.length = 0;
  await scanUniverse(provider, [v4f, v2], { usdToken: USDG, wrappedNative: WETH, now: () => clock, log: () => {} }, st);
  assert(pmAsks.length > 0 && pmAsks.every((a) => a.from >= 101), 'next scan the same day reads only new blocks');

  // ONLY1 lists on V2 later; the daily re-read then picks up its V4 pool,
  // without duplicating X1/WETH.
  chainLogs.push(pairLog(ONLY1, WETH, A(0x6201), 130));
  head = 140; clock += 25 * 3600_000; pmAsks.length = 0;
  await scanUniverse(provider, [v4f, v2], { usdToken: USDG, wrappedNative: WETH, now: () => clock, log: () => {} }, st);
  assert(pmAsks.some((a) => a.from === 0), 'after a day: V4 history re-read from block 0');
  const ids = v4in().map((p) => p.pool);
  assert(v4in().length === 2 && new Set(ids).size === 2 && v4in().some((p) => [p.token0, p.token1].includes(ONLY1.toLowerCase())), 'coin that listed elsewhere later: its V4 pool picked up, nothing duplicated');

  // Ceiling: 5 keepable V4 pools, ceiling 3 -> 3 kept, and the log says so.
  const st2 = emptyScanState();
  chainLogs = [...Y.map((y, i) => pairLog(y, WETH, A(0x6100 + i), 5)), ...Y.map((y, i) => v4Init(y, WETH, 3000, 10 + i))];
  head = 100;
  const lines2: string[] = [];
  await scanUniverse(provider, [v2, v4f], { usdToken: USDG, wrappedNative: WETH, maxV4Pools: 3, now: () => clock, log: (m) => lines2.push(m) }, st2);
  assert(stateToPools(st2).filter((p) => p.kind === 'v4').length === 3, 'ceiling: never more V4 pools than the limit');
  assert(lines2.some((l) => /2 over the 3 ceiling NOT kept/.test(l)), 'ceiling reached is logged (status page shows it)');
  // Daily re-read at the ceiling: saved pools don't count as new, none added.
  clock += 25 * 3600_000;
  await scanUniverse(provider, [v2, v4f], { usdToken: USDG, wrappedNative: WETH, maxV4Pools: 3, now: () => clock, log: () => {} }, st2);
  assert(stateToPools(st2).filter((p) => p.kind === 'v4').length === 3, 'daily re-read at the ceiling: still exactly the limit');

  // Clean-up: a map saved by the unfiltered version (V4-only coin pools)
  // is cleaned on load, the good pool kept.
  const st3 = emptyScanState();
  addPoolsToState(st3, v2, [{ dex: 'uniswap-v2', kind: 'v2', pool: A(0x7001), token0: X1.toLowerCase(), token1: WETH.toLowerCase() }]);
  const mk = (a: string, b: string, n: number): ScannedPool => ({ dex: 'uniswap-v4', kind: 'v4', pool: '0x' + n.toString(16).padStart(64, '0'), token0: a.toLowerCase(), token1: b.toLowerCase(), v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: PM.toLowerCase(), stateView: SV.toLowerCase() } });
  addPoolsToState(st3, v4f, [mk(X1, WETH, 1), mk(ONLY1, WETH, 2), mk(ONLY2, WETH, 3)]);
  assert(pruneV4(st3) === 2 && stateToPools(st3).filter((p) => p.kind === 'v4').length === 1 && Object.keys(st3.v4 ?? {}).length === 1, 'old unfiltered map cleaned: V4-only coin pools removed, details too');
  assert(pruneV4(st3) === 0, 'clean-up is safe to repeat');
}
main().then(filterTests);
