// ============================================================================
// EXCHANGE PROBE (research, read-only, never sends anything)
//
// Plain English:
//   For every pool in the Oct 16 pair workbook (scripts/data/
//   exchange-probe-pools.json) this asks the chain itself what the pool is,
//   so we add exchanges from facts, not guesses:
//     1. Normal pools (20-byte address): which factory made it, its two
//        coins, fee, tick spacing, which price function it answers
//        (slot0 / globalState / getReserves) and which "pay me" callback its
//        code calls (that decides whether our contract can trade it).
//     2. Pool ids (32 bytes, Uniswap V4 style): which contract created the
//        pool (its Initialize event) and the full pool key, including the
//        HOOK address. The hook address itself says what the hook may do
//        (its last 14 bits are permission flags), so we can sort hooked
//        pools into "safe to price like a plain pool", "fee may change per
//        swap" and "custom maths, leave out".
//     3. Every candidate exchange contract (from the DefiLlama adapters and
//        our own list): does code exist there, and what does the public
//        explorer call it.
//   Writes results/exchange-probe.json (the workflow commits it back to the
//   branch) and prints a short summary.
//
// Run: npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-exchanges.js
// Settings: ROBINHOOD_RPC_URL, PROBE_PACE_MS (default 120), PROBE_LOG_RANGE
// (default 2,000,000 blocks per log request, split automatically on errors)
// ============================================================================
import { ethers } from 'ethers';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const PACE = Number(process.env.PROBE_PACE_MS ?? 120);
const LOG_RANGE = Number(process.env.PROBE_LOG_RANGE ?? 2_000_000);
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/api/v2';
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const UNI_V4_PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const UNI_V4_STATE_VIEW = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const FABLES_REGISTRY = '0x159a113e012593d9b3cc63ad45e30f0467e13ef3';

// Contracts that may have created the workbook pools. Names are what the
// source calls them; the probe checks code exists and asks the explorer.
const CANDIDATES: Record<string, string> = {
  '0x8366a39cc670b4001a1121b8f6a443a643e40951': 'Uniswap V4 PoolManager',
  '0xd01c774d4a66408326bc65728ac5ae5aaf004032': 'Orvex CLPoolManager (DefiLlama dexs/orvex.ts)',
  '0xfe7e25de55e5cbbeccccb661f3679f873f72b9b0d': 'Orvex Vault',
  '0x3d4afd3190b1e5036e410abb576f99c02d6fbb20': 'Latch CLPoolManager (DefiLlama dexs/latch-protocol.ts)',
  '0xbd6274d94102c3fcafe043f8ef7c7f33f33b255a': 'Latch BinPoolManager',
  '0xac44c903ce3d89054fd5b70e0e396f26b214cbe3': 'Latch Vault',
  '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b': 'PancakeSwap Infinity CLPoolManager (BSC/Base address)',
  '0x238a358808379702088667322f80ac48bad5e6c4': 'PancakeSwap Infinity Vault (BSC/Base address)',
  '0xc697d2898e0d09264376196696c51d7abbbaa4a9': 'PancakeSwap Infinity BinPoolManager (BSC/Base address)',
  '0x00000000000014aa86c5d3c41765bb24e11bd701': 'Ekubo core',
  '0x9a8442cb89fe713ce7c2f22852e61fbffee97ecf': 'Ouro DEX V3 factory (DefiLlama factory/uniV3.ts)',
  '0xe7fef2bc860b25bbdeb6f6ab96d88baaa77ddad7': 'unnamed factory from the Oct 8 rival study',
  '0xcefc5da47d766fb6b48da92d75d66b3264593d0f': 'Hybra V3 factory',
  '0xea561e058313b96011e5070ca7d0f027a44e3748': 'RobinSwap V3 factory',
  '0xd479e71c45aeb1e846a7b549c346d62fe77b39ba': 'ParitySwap V3 factory',
  '0x21fd9ab06cc927e66013e89b045c26b3ede7bb20': 'Sheriff V3 factory (Algebra)',
  '0xc802a440559cee8a66e2023403d34be9084a720e': 'Zero-swap V2 factory',
  '0x76c1d39c33b773abe8fbdd6253f4d09b735b2e7b': 'Hybra V2 factory',
  '0xa95da9b9fcef09a07f99444fe9304457d6ecdcca': 'RobinSwap V2 factory',
  '0xaf0660fd4d96f4e925ae85eba7a90a74c727fa2f': 'Ouro DEX V2 factory',
  '0x002ec9782d70f4e79396c58964d4691ca648fb49': 'Catnip V2 factory',
  '0x10f7d1ef77f58181484936170430df13539c5162': 'Sheriff V2 factory',
  '0xaa5f8c18ef9be81ffed30c223f9cd0d012a2adb9': 'ParitySwap V2 factory',
  '0x5c98b2d892b37c9a1d3b69472bddc172a64cdc09': 'Orvex V2 (Solidly) factory',
  '0x2b1b1fb977e1cd5f18f45571c64e373b1a73dd7f': 'Frothswap factory',
  '0xdb2ec80e55527b5d858b54173083139679f5de6f': 'Kolswap factory',
  '0x6af79510599de74e5922a2771b29160da8b7b4c1': 'Kolswap factory 2',
  '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb': 'Noxa-fun factory',
  '0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007': 'Virtual protocol factory',
  '0x1e3ac31cf96b20619c913384c9bf6010a824fb95': 'Topaz V2 PoolFactory',
  '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e': 'Pons V2 launcher factory',
  '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044': 'Pons V2 meme hook',
  '0xf2f1c1d5089995c55c9bf0395ebb70ebbf17b61d': 'HookOS PoolFactory',
  // already in the bot (for labelling pool factories)
  '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f': 'Uniswap V2 factory (bot)',
  '0x1f7d7550b1b028f7571e69a784071f0205fd2efa': 'Uniswap V3 factory (bot)',
  '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865': 'PancakeSwap V3 factory (bot)',
  '0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e': 'PancakeSwap V2 factory (bot)',
  '0x43b2bf9f33036a02fc7a00935571c2a6b0108e66': 'Ramses V2 factory (bot)',
  '0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8': 'Ramses V3 factory (bot)',
  '0x16494a80e08bcb9285d87b67149d7b01774d82f8': 'Alandale factory (bot extra)',
  '0xece6ecd61177336ea6fb9b17937ac439d85ee20b': 'GIGA CL factory (bot extra)',
  '0x6fdf38f92ead1adfc04b73aaa947ab254f6c0916': 'GIGA Classic factory (bot extra)',
  '0x831880bd3b331249df63bacc6e21495e5e8f1eaa': 'GIGA BrownFi factory (bot extra)',
  '0x1ac9db4a2608ba45d6127b1737949b51bb54b7f3': 'UP CL factory (bot extra)',
  '0x0ec554f0bff0be6c99d1e95c8015bb0950f6a2c7': 'SwapHood V3 factory (bot extra)',
  '0xaa5865dc3a60b25d305226d66fd573021f0d8ffb': 'Topaz CL factory (bot extra)',
  '0x5481864ddd46a2d798df0925c23b7846e776e5e3': 'Raphael CL factory (bot extra)',
  '0xe51960f1b45f1c9fb6d166e6a884f866fc70433b': 'SushiSwap V3 factory (bot extra)',
  '0xf03875b5ec5eac83cab83a6c2ab17844304aa7a0': 'KittenSwap factory (bot extra)',
  '0x221a6239e40709792b0d4bdc140fa36158cd41c7': 'Goo factory (bot extra)',
};

// "Pay me" callbacks a pool's code may call. Our contract knows the first four.
const CALLBACKS: Record<string, string> = {
  uniswapV3SwapCallback: 'uniswapV3SwapCallback(int256,int256,bytes)',
  pancakeV3SwapCallback: 'pancakeV3SwapCallback(int256,int256,bytes)',
  algebraSwapCallback: 'algebraSwapCallback(int256,int256,bytes)',
  ramsesV2SwapCallback: 'ramsesV2SwapCallback(int256,int256,bytes)',
  uniswapV2Call: 'uniswapV2Call(address,uint256,uint256,bytes)',
  pancakeCall: 'pancakeCall(address,uint256,uint256,bytes)',
  hook: 'hook(address,uint256,uint256,bytes)',
  solidlyV3SwapCallback: 'solidlyV3SwapCallback(int256,int256,bytes)',
  agniSwapCallback: 'agniSwapCallback(int256,int256,bytes)',
  swapCallback: 'swapCallback(int256,int256,bytes)',
};
const CB_SEL = Object.fromEntries(Object.entries(CALLBACKS).map(([k, s]) => [k, ethers.id(s).slice(2, 10)]));

// Initialize events of V4-style pool managers (Uniswap V4 and PancakeSwap Infinity CL layouts).
const T_INIT_UNI = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const T_INIT_PCS = ethers.id('Initialize(bytes32,address,address,address,uint24,bytes32,uint160,int24)');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const provider = new ethers.JsonRpcProvider(URL_, 4663, { staticNetwork: true, batchMaxCount: 1 });
let lastCall = 0;
let calls = 0;
// One JSON-RPC request, paced, with back-off on "slow down" answers.
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCall + PACE - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    calls++;
    try { return await provider.send(method, params); }
    catch (e) {
      const m = String((e as any)?.message ?? e);
      if (/403|429|rate|too many|timeout|ETIMEDOUT|ECONNRESET|socket/i.test(m)) { await sleep(2_000 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw new Error(`${method}: node kept refusing`);
}

// Multicall3 aggregate3 in bundles; null for a failed inner call.
const mc = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
async function callMany(items: { target: string; data: string }[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < items.length; i += 150) {
    const chunk = items.slice(i, i + 150);
    const data = mc.encodeFunctionData('aggregate3', [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
    const raw = await rpc('eth_call', [{ to: MC3, data }, 'latest']);
    const [res] = mc.decodeFunctionResult('aggregate3', raw);
    for (const r of res as any[]) out.push(r.success && r.returnData !== '0x' ? r.returnData : null);
  }
  return out;
}

// Explorer name for a contract (verified name, or token name), never throws.
async function explorerName(addr: string): Promise<string | null> {
  try {
    const r = await fetch(`${BLOCKSCOUT}/addresses/${addr}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.name ?? j?.implementations?.[0]?.name ?? (j?.is_contract ? '(unverified contract)' : null);
  } catch { return null; }
}

// What a V4 hook address says it may do (last 14 bits are permission flags).
function hookFlags(hook: string) {
  const v = Number(BigInt(hook) & 0x3fffn);
  const f = (bit: number) => (v & (1 << bit)) !== 0;
  const flags = {
    beforeInitialize: f(13), afterInitialize: f(12), beforeAddLiquidity: f(11), afterAddLiquidity: f(10),
    beforeRemoveLiquidity: f(9), afterRemoveLiquidity: f(8), beforeSwap: f(7), afterSwap: f(6),
    beforeDonate: f(5), afterDonate: f(4), beforeSwapReturnsDelta: f(3), afterSwapReturnsDelta: f(2),
    afterAddLiquidityReturnsDelta: f(1), afterRemoveLiquidityReturnsDelta: f(0),
  };
  // Swap maths are a plain V4 pool's maths unless the hook can change the
  // swap's amounts (returns-delta flags). beforeSwap alone can only change
  // the fee (dynamic-fee pools) or refuse the swap.
  const swapClass = flags.beforeSwapReturnsDelta || flags.afterSwapReturnsDelta ? 'custom-amounts'
    : flags.beforeSwap ? 'fee-may-change-per-swap'
    : flags.afterSwap ? 'after-swap-only'
    : 'plain-swap-maths';
  return { bits: v, flags, swapClass };
}

async function main() {
  const t0 = Date.now();
  const pools: any[] = JSON.parse(readFileSync('scripts/exchange-probe-pools.json', 'utf8'));
  const latest = Number(await rpc('eth_blockNumber', []));
  console.log(`[probe] ${pools.length} pools, latest block ${latest}`);
  const result: any = { latestBlock: latest, at: new Date().toISOString(), candidates: {}, pools20: [], pools32: [], hooks: {}, errors: [] };

  // ---- 3. Candidate contracts: code size + explorer name ------------------
  for (const [addr, label] of Object.entries(CANDIDATES)) {
    try {
      const code: string = await rpc('eth_getCode', [addr, 'latest']);
      result.candidates[addr] = { label, codeBytes: (code.length - 2) / 2, explorer: code.length > 2 ? await explorerName(addr) : null };
    } catch (e) { result.errors.push(`code ${addr}: ${(e as Error).message}`); }
  }
  console.log('[probe] candidates done');

  // ---- 1. Normal pools -----------------------------------------------------
  const p20 = pools.filter((p) => p.pool.length === 42);
  const sels = {
    factory: ethers.id('factory()').slice(0, 10), token0: ethers.id('token0()').slice(0, 10), token1: ethers.id('token1()').slice(0, 10),
    fee: ethers.id('fee()').slice(0, 10), tickSpacing: ethers.id('tickSpacing()').slice(0, 10), liquidity: ethers.id('liquidity()').slice(0, 10),
    slot0: ethers.id('slot0()').slice(0, 10), globalState: ethers.id('globalState()').slice(0, 10), getReserves: ethers.id('getReserves()').slice(0, 10),
    stable: ethers.id('stable()').slice(0, 10), plugin: ethers.id('plugin()').slice(0, 10),
  };
  const items = p20.flatMap((p) => Object.values(sels).map((s) => ({ target: p.pool, data: s })));
  const answers = await callMany(items);
  const names = Object.keys(sels);
  for (let i = 0; i < p20.length; i++) {
    const a = answers.slice(i * names.length, (i + 1) * names.length);
    const g = (k: string) => a[names.indexOf(k)];
    const word = (x: string | null) => (x && x.length >= 66 ? '0x' + x.slice(26, 66) : null);
    const num = (x: string | null) => (x && x.length >= 66 ? BigInt(x.slice(0, 66)).toString() : null);
    let callbacks: string[] = [], codeBytes = 0;
    try {
      const code: string = await rpc('eth_getCode', [p20[i].pool, 'latest']);
      codeBytes = (code.length - 2) / 2;
      // EIP-1167 minimal proxy: read the implementation's code instead.
      let body = code.toLowerCase();
      const m = body.match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
      if (m) body = String(await rpc('eth_getCode', ['0x' + m[1], 'latest'])).toLowerCase();
      callbacks = Object.entries(CB_SEL).filter(([, s]) => body.includes('63' + s)).map(([k]) => k);
    } catch (e) { result.errors.push(`code ${p20[i].pool}: ${(e as Error).message}`); }
    const factory = word(g('factory'));
    result.pools20.push({
      ...p20[i], codeBytes, factory, factoryLabel: factory ? CANDIDATES[factory.toLowerCase()] ?? null : null,
      token0: word(g('token0')), token1: word(g('token1')), feeRaw: num(g('fee')), tickSpacing: g('tickSpacing') ? ethers.AbiCoder.defaultAbiCoder().decode(['int24'], g('tickSpacing')!)[0].toString() : null,
      liquidity: num(g('liquidity')), hasSlot0: !!g('slot0'), hasGlobalState: !!g('globalState'), hasReserves: !!g('getReserves'),
      stable: g('stable') ? BigInt(g('stable')!.slice(0, 66)) === 1n : null, plugin: word(g('plugin')), callbacks,
    });
  }
  // Unknown factories: ask the explorer once each.
  const unknownF = [...new Set(result.pools20.filter((p: any) => p.factory && !p.factoryLabel).map((p: any) => p.factory.toLowerCase()))] as string[];
  result.unknownFactories = {};
  for (const f of unknownF) result.unknownFactories[f] = await explorerName(f);
  console.log(`[probe] ${p20.length} normal pools done, ${unknownF.length} unknown factories`);

  // ---- 2. Pool ids: Initialize events -------------------------------------
  const p32 = pools.filter((p) => p.pool.length === 66);
  const ids = [...new Set(p32.map((p) => p.pool.toLowerCase()))];
  const managers = Object.entries(result.candidates).filter(([, c]: any) => c.codeBytes > 0 && /PoolManager|Ekubo/i.test(c.label)).map(([a]) => a);
  const found = new Map<string, any>();
  // Fast path: the public explorer's indexed log search, one id at a time.
  const decodeInit = (l: any) => {
    const id = String(l.topics[1]).toLowerCase();
    const c0 = '0x' + String(l.topics[2]).slice(26), c1 = '0x' + String(l.topics[3]).slice(26);
    const d = String(l.data).slice(2);
    const w = (i: number) => d.slice(i * 64, (i + 1) * 64);
    let key: any;
    if (String(l.topics[0]).toLowerCase() === T_INIT_UNI.toLowerCase()) {
      key = { layout: 'uniswap-v4', fee: Number(BigInt('0x' + w(0))), tickSpacing: Number(BigInt.asIntN(24, BigInt('0x' + w(1)))), hooks: '0x' + w(2).slice(24) };
    } else {
      const params = '0x' + w(2);
      key = { layout: 'pancake-infinity-cl', hooks: '0x' + w(0).slice(24), fee: Number(BigInt('0x' + w(1))), parameters: params,
        tickSpacing: Number(BigInt.asIntN(24, (BigInt(params) >> 16n) & 0xffffffn)) };
    }
    const addr = String(l.address).toLowerCase();
    found.set(id, { manager: addr, managerLabel: CANDIDATES[addr] ?? null, block: Number(l.blockNumber), currency0: c0, currency1: c1, ...key, dynamicFee: (key.fee & 0x800000) !== 0 });
  };
  for (const id of (process.env.PROBE_EXPLORER === '1' ? ids : [])) {
    for (const m of managers) {
      if (found.has(id)) break;
      for (const t0 of [T_INIT_UNI, T_INIT_PCS]) {
        try {
          const u = `https://robinhoodchain.blockscout.com/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${m}&topic0=${t0}&topic1=${id}&topic0_1_opr=and`;
          const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
          const j: any = r.ok ? await r.json() : null;
          for (const l of (Array.isArray(j?.result) ? j.result : [])) decodeInit(l);
        } catch (e) { result.errors.push(`explorer logs ${id.slice(0, 10)}: ${(e as Error).message.slice(0, 80)}`); }
        await sleep(150);
        if (found.has(id)) break;
      }
    }
  }
  console.log(`[probe] explorer log search: ${found.size}/${ids.length} ids found`);
  // Precise path: each workbook pool has its creation time, so find the
  // block at that time (binary search on block timestamps) and ask the node
  // for Initialize logs in a small window around it.
  const tsCache = new Map<number, number>();
  const blockTime = async (n: number): Promise<number> => {
    if (tsCache.has(n)) return tsCache.get(n)!;
    const b = await rpc('eth_getBlockByNumber', [ethers.toQuantity(n), false]);
    const t = Number(b.timestamp); tsCache.set(n, t); return t;
  };
  const blockAt = async (unix: number): Promise<number> => {
    let lo = 0, hi = latest;
    while (hi - lo > 2_000) { const mid = Math.floor((lo + hi) / 2); if (await blockTime(mid) < unix) lo = mid; else hi = mid; }
    return lo;
  };
  const createdOf = new Map<string, number>();
  for (const p of p32) { const t = Date.parse(String(p.created).replace(' ', 'T') + (String(p.created).endsWith('Z') ? '' : 'Z')); if (Number.isFinite(t)) createdOf.set(p.pool.toLowerCase(), Math.floor(t / 1000)); }
  for (const id of ids) {
    if (found.has(id) || !createdOf.has(id)) continue;
    try {
      const b = await blockAt(createdOf.get(id)!);
      for (const win of [20_000, 200_000]) {
        const f = Math.max(0, b - win), t = Math.min(latest, b + win);
        try {
          const logs: any[] = await rpc('eth_getLogs', [{ address: managers, fromBlock: ethers.toQuantity(f), toBlock: ethers.toQuantity(t), topics: [[T_INIT_UNI, T_INIT_PCS], [id]] }]);
          for (const l of logs) decodeInit(l);
        } catch (e) { result.errors.push(`window logs ${id.slice(0, 10)} +-${win}: ${(e as Error).message.slice(0, 100)}`); }
        if (found.has(id)) break;
      }
    } catch (e) { result.errors.push(`block for ${id.slice(0, 10)}: ${(e as Error).message.slice(0, 100)}`); }
  }
  console.log(`[probe] creation-time window search: ${found.size}/${ids.length} ids found (${calls} requests)`);
  const missing = ids.filter((id) => !found.has(id));
  for (let k = 0; k < (process.env.PROBE_RPC_LOGS === '1' ? missing.length : 0); k += 40) {
    const chunk0 = missing;
    const chunk = chunk0.slice(k, k + 40);
    const stack: [number, number][] = [];
    for (let f = 0; f <= latest; f += LOG_RANGE) stack.push([f, Math.min(latest, f + LOG_RANGE - 1)]);
    stack.reverse();
    while (stack.length) {
      const [f, t] = stack.pop()!;
      try {
        const logs: any[] = await rpc('eth_getLogs', [{ address: managers, fromBlock: ethers.toQuantity(f), toBlock: ethers.toQuantity(t), topics: [[T_INIT_UNI, T_INIT_PCS], chunk] }]);
        for (const l of logs) {
          const id = l.topics[1].toLowerCase();
          const c0 = '0x' + l.topics[2].slice(26), c1 = '0x' + l.topics[3].slice(26);
          const d = l.data.slice(2);
          const w = (i: number) => d.slice(i * 64, (i + 1) * 64);
          let key: any;
          if (l.topics[0] === T_INIT_UNI) {
            const ts = BigInt.asIntN(24, BigInt('0x' + w(1)));
            key = { layout: 'uniswap-v4', fee: Number(BigInt('0x' + w(0))), tickSpacing: Number(ts), hooks: '0x' + w(2).slice(24) };
          } else {
            const params = '0x' + w(2);
            key = { layout: 'pancake-infinity-cl', hooks: '0x' + w(0).slice(24), fee: Number(BigInt('0x' + w(1))), parameters: params,
              tickSpacing: Number(BigInt.asIntN(24, (BigInt(params) >> 16n) & 0xffffffn)) };
          }
          found.set(id, { manager: l.address.toLowerCase(), managerLabel: CANDIDATES[l.address.toLowerCase()] ?? null, block: Number(l.blockNumber), currency0: c0, currency1: c1, ...key,
            dynamicFee: (key.fee & 0x800000) !== 0 });
        }
      } catch (e) {
        if (t - f > 1_000) { const mid = Math.floor((f + t) / 2); stack.push([mid + 1, t], [f, mid]); }
        else result.errors.push(`logs ${f}-${t}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    console.log(`[probe] rpc ids ${k + chunk.length}/${missing.length}: ${found.size} found (${calls} requests)`);
  }

  // Live state of Uniswap V4 pools found (price, liquidity, current LP fee),
  // and whether Fables lists them.
  let fables = new Set<string>();
  try {
    const raw = await rpc('eth_call', [{ to: FABLES_REGISTRY, data: ethers.id('activePools()').slice(0, 10) }, 'latest']);
    const [arr] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32[]'], raw);
    fables = new Set((arr as string[]).map((x) => x.toLowerCase()));
  } catch (e) { result.errors.push(`fables activePools: ${(e as Error).message.slice(0, 100)}`); }
  const sv = new ethers.Interface(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)']);
  const uniIds = [...found.entries()].filter(([, v]) => v.layout === 'uniswap-v4' && v.manager === UNI_V4_PM.toLowerCase()).map(([id]) => id);
  const st = await callMany(uniIds.flatMap((id) => [{ target: UNI_V4_STATE_VIEW, data: sv.encodeFunctionData('getSlot0', [id]) }, { target: UNI_V4_STATE_VIEW, data: sv.encodeFunctionData('getLiquidity', [id]) }]));
  uniIds.forEach((id, i) => {
    const s0 = st[2 * i], lq = st[2 * i + 1];
    const v = found.get(id);
    if (s0) { const d = sv.decodeFunctionResult('getSlot0', s0); v.sqrtPriceX96 = d[0].toString(); v.tick = Number(d[1]); v.protocolFee = Number(d[2]); v.lpFee = Number(d[3]); }
    if (lq) v.liquidity = sv.decodeFunctionResult('getLiquidity', lq)[0].toString();
    v.inFablesRegistry = fables.has(id);
  });

  for (const p of p32) {
    const v = found.get(p.pool.toLowerCase());
    result.pools32.push({ ...p, initialize: v ?? null });
  }
  // Hooks: flags, code size, explorer name.
  const hooks = [...new Set([...found.values()].map((v) => v.hooks).filter((h) => h && h !== ethers.ZeroAddress))];
  for (const h of hooks) {
    let codeBytes = 0;
    try { codeBytes = ((await rpc('eth_getCode', [h, 'latest'])) as string).length / 2 - 1; } catch { /* keep 0 */ }
    const pl = result.pools32.filter((p: any) => p.initialize?.hooks === h);
    result.hooks[h] = { ...hookFlags(h), codeBytes, explorer: await explorerName(h), pools: pl.length,
      liqUsd: pl.reduce((s: number, p: any) => s + p.liq, 0), vol24Usd: pl.reduce((s: number, p: any) => s + p.vol24, 0),
      pairs: [...new Set(pl.map((p: any) => p.pair))].slice(0, 12) };
  }
  result.fablesRegistrySize = fables.size;
  result.requests = calls;
  result.seconds = Math.round((Date.now() - t0) / 1000);
  mkdirSync('results', { recursive: true });
  writeFileSync('results/exchange-probe.json', JSON.stringify(result, null, 1));
  console.log(`[probe] done in ${result.seconds}s, ${calls} requests, ${found.size}/${ids.length} ids found, ${hooks.length} hooks, ${result.errors.length} errors`);
}

main().catch((e) => { console.error('[probe] failed:', e); process.exit(1); });
