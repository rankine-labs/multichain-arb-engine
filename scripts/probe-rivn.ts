// ============================================================================
// RIVN PROBE (Oct 22, copy2-r) -- the "RIVN/USDG gap" fast-check mismatches.
//
// Plain English: in the Oct 22 21:22 shadow hour copy 2 said "the trade
// reverts" four times on RIVN/USDG while the node, asked at the very same
// block, said "completes at a loss". This read-only script asks the live
// node what those checks really do at those blocks:
//   1. finds the RIVN token and every RIVN/USDG pool (V3 / V4),
//   2. describes the token (proxy, functions, settings),
//   3. at each mismatch block runs the bot's own check (simulateRoundTrip,
//      own money, start USDG) for every pool pair and a few sizes, with the
//      gas the node reports,
//   4. for the checks closest to the copy's gas (841,669) prints the call
//      tree (callTracer) and every storage value the check read
//      (prestateTracer) for the token, its beacon and the PoolManager.
// Read-only. No keys, no transactions.
// ============================================================================
import { ethers } from 'ethers';
import { makeRpc, simulateRoundTrip, SIM_EXECUTOR_ADDRESS, SIM_CALLER, findBalanceSlot } from '../src/execution/simulator';
import { buildExecuteCall, encodeExecuteRaw } from '../src/execution/executorCalldata';
import { ARB_EXECUTOR_RUNTIME_CODE, EXECUTOR_STORAGE_SLOT, V4_POOL_MANAGER_STORAGE_SLOT, WETH_STORAGE_SLOT } from '../src/execution/arbExecutorBytecode';
import { discoverPairPools, Venue } from '../src/core/pairWatcher';
import { ROBINHOOD_TOKENS, ROBINHOOD_V3, ROBINHOOD_RAMSES, ROBINHOOD_V4 } from '../src/config/knownAddresses';
import { PoolState } from '../src/core/types';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const WANT = (process.env.PROBE_SYMBOL ?? 'RIVN').toUpperCase();
const MISMATCH_BLOCKS = '0x5b03bfb,0x5b03c03,0x5b07fbd,0x5b080b5';
let BLOCKS = (process.env.PROBE_BLOCKS ?? MISMATCH_BLOCKS).split(',').map((s) => s.trim()).filter(Boolean);
const COPY_GAS = 841_669;
const USDG = ROBINHOOD_TOKENS.USDG.toLowerCase();
const PM = ROBINHOOD_V4.POOL_MANAGER.toLowerCase();
const provider = new ethers.JsonRpcProvider(URL_, 4663, { staticNetwork: true });
const base = makeRpc(URL_, 20_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = async (m: string, p: unknown[]) => {
  for (let i = 0; i < 6; i++) {
    const r = await base(m, p);
    if (!r.error || !/429|too many|rate|network:|timeout/i.test(JSON.stringify(r.error))) return r;
    await sleep(1500 * (i + 1));
  }
  return base(m, p);
};
const pad = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const short = (x: unknown, n = 220) => JSON.stringify(x).slice(0, n);
const say = (s: string) => console.log(s);
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);

async function view(to: string, sig: string, args = '', tag = 'latest'): Promise<string> {
  const r = await rpc('eth_call', [{ to, data: ethers.id(sig).slice(0, 10) + args }, tag]);
  return r.error ? `ERR ${short(r.error, 160)}` : String(r.result);
}
const big = (x: string) => { try { return BigInt(x.slice(0, 66)); } catch { return -1n; } };
const str = (x: string) => { try { return ethers.AbiCoder.defaultAbiCoder().decode(['string'], x)[0] as string; } catch { return '?'; } };

async function logsChunked(filter: Record<string, unknown>, from: number, to: number): Promise<any[]> {
  const r = await rpc('eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]);
  if (!r.error) return r.result ?? [];
  if (to - from < 50_000) { say(`  getLogs ${from}-${to}: ERR ${short(r.error, 120)}`); return []; }
  const mid = Math.floor((from + to) / 2);
  return [...(await logsChunked(filter, from, mid)), ...(await logsChunked(filter, mid + 1, to))];
}

// The coin: every Transfer-emitting contract in the few blocks before each
// mismatch block (the gap's trigger trade is there), by symbol.
async function findCoin(): Promise<string | null> {
  const topic = ethers.id('Transfer(address,address,uint256)');
  const seen = new Set<string>();
  for (const b of MISMATCH_BLOCKS.split(',')) {
    const n = parseInt(b, 16);
    const logs = await rpc('eth_getLogs', [{ topics: [topic], fromBlock: hex(n - 40), toBlock: hex(n) }]);
    if (logs.error) { say(`  getLogs near ${b}: ERR ${short(logs.error, 120)}`); continue; }
    for (const l of logs.result ?? []) {
      const a = String(l.address).toLowerCase();
      if (seen.has(a)) continue;
      seen.add(a);
      const sym = str(await view(a, 'symbol()'));
      if (sym.toUpperCase() === WANT || sym.toUpperCase().startsWith(WANT)) { say(`  ${WANT} = ${a} (symbol "${sym}", name "${str(await view(a, 'name()'))}")`); return a; }
    }
  }
  say(`  coins seen near the blocks: ${seen.size}, none is ${WANT}`);
  return null;
}

async function tokenSection(coin: string) {
  say(`== token ${coin}`);
  const word = async (a: string, slot: string) => String((await rpc('eth_getStorageAt', [a, slot, 'latest'])).result ?? '0x');
  const beacon = '0x' + (await word(coin, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50')).slice(-40);
  const impl1967 = '0x' + (await word(coin, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc')).slice(-40);
  let logic = /^0x0+$/.test(impl1967) ? null : impl1967;
  if (!logic && !/^0x0+$/.test(beacon)) { const r = await view(beacon, 'implementation()'); if (!r.startsWith('ERR')) logic = '0x' + r.slice(-40); }
  say(`beacon ${beacon} impl ${logic}`);
  for (const f of ['decimals()', 'totalSupply()', 'paused()', 'multiplier()', 'owner()', 'version()']) {
    const r = await view(coin, f);
    if (!r.startsWith('ERR')) say(`  ${f} -> ${r.slice(0, 130)}`);
  }
}

function v4Of(p: PoolState) { return (p as any).v4 as { poolManager: string; fee: number; tickSpacing: number; hooks?: string } | undefined; }

(async () => {
  const latest = Number((await rpc('eth_blockNumber', [])).result);
  say(`latest block ${latest} (${hex(latest)})`);
  // How far back does this node keep state?
  for (const back of [10, 100, 400, 1000, 4000]) {
    const r = await rpc('eth_getBalance', [PM, hex(latest - back)]);
    say(`  state ${back} blocks back: ${r.error ? 'NO' : 'yes'}`);
  }
  // "latest": one fixed recent block for the whole probe (the gap stands).
  if (BLOCKS.length === 1 && BLOCKS[0] === 'latest') BLOCKS = [hex(latest - 2)];
  // Archive? (state at the first mismatch block)
  const arch = await rpc('eth_getBalance', [PM, BLOCKS[0]]);
  say(`state at ${BLOCKS[0]}: ${arch.error ? 'NOT AVAILABLE ' + short(arch.error, 160) : 'available'}`);
  for (const b of BLOCKS) {
    const blk = await rpc('eth_getBlockByNumber', [b, false]);
    say(`block ${b} = ${parseInt(b, 16)} at ${blk.result ? new Date(parseInt(blk.result.timestamp, 16) * 1000).toISOString() : short(blk.error)}`);
  }
  const coin = process.env.PROBE_TOKEN?.toLowerCase() ?? await findCoin();
  if (!coin) { say(`${WANT} not found`); process.exit(0); }
  await tokenSection(coin);
  const dec = Number(big(await view(coin, 'decimals()')));
  const venues: Venue[] = [
    { dex: 'uniswap-v3', kind: 'v3-fee', factory: ROBINHOOD_V3.FACTORY },
    { dex: 'ramses-v3', kind: 'v3-spacing', factory: ROBINHOOD_RAMSES.V3_FACTORY },
    { dex: 'uniswap-v4', kind: 'v4', factory: ROBINHOOD_V4.STATE_VIEW, poolManager: ROBINHOOD_V4.POOL_MANAGER, weth: ROBINHOOD_TOKENS.WETH },
  ];
  const pools = (await discoverPairPools(provider, 'robinhood', venues, USDG, coin)).filter((p) => !v4Of(p)?.hooks || /^0x0+$/.test(v4Of(p)!.hooks!));
  say(`== pools (${pools.length})`);
  for (const p of pools) {
    const v = v4Of(p);
    say(`  ${p.dex} ${p.poolAddress}${v ? ` fee ${v.fee} spacing ${v.tickSpacing}` : ''} L=${p.liquidity} sqrtP=${p.sqrtPriceX96}`);
  }
  // Balance slots (how a copy finds them): the bot's lookup on both coins.
  for (const t of [coin, USDG]) {
    try { const s = await findBalanceSlot(rpc, 'robinhood:' + t, t); say(`balance slot lookup ${t}: ${s === null ? 'NOT FOUND' : short(s && 'slot' in (s as any) ? (s as any).slot : s, 200)}`); } catch (e) { say(`balance slot lookup ${t}: error ${(e as Error).message}`); }
  }
  const slot = await findBalanceSlot(rpc, 'robinhood:' + USDG, USDG);
  // Where RIVN keeps the PoolManager's / a pool's balance: the slots balanceOf reads.
  for (const holder of [PM, ...pools.filter((p) => !v4Of(p)).map((p) => p.poolAddress)]) {
    const tr = await rpc('debug_traceCall', [{ to: coin, data: ethers.id('balanceOf(address)').slice(0, 10) + pad(holder) }, BLOCKS[0], { tracer: 'prestateTracer' }]);
    const bal = await view(coin, 'balanceOf(address)', pad(holder), BLOCKS[0]);
    if (tr.error) { say(`balanceOf(${holder}) trace: ${short(tr.error, 160)}`); continue; }
    say(`balanceOf(${holder.slice(0, 10)}) = ${big(bal)} reads:`);
    for (const [a, acct] of Object.entries<any>(tr.result ?? {})) for (const [k, v] of Object.entries<any>(acct.storage ?? {})) say(`   ${a.slice(0, 10)} ${k} = ${v}`);
  }
  for (const p of pools.filter((q) => v4Of(q))) {
    const baseSlot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [p.poolAddress, 6]));
    const s0 = (await rpc('eth_getStorageAt', [PM, baseSlot, BLOCKS[0]])).result;
    const liq = (await rpc('eth_getStorageAt', [PM, hex(BigInt(baseSlot) + 3n), BLOCKS[0]])).result;
    say(`v4 ${p.poolAddress.slice(0, 10)} slot0 ${s0} liquidity ${liq}`);
  }
  // The copy's assumed values, tried on the REAL chain state with state
  // overrides (PROBE_OVR): the PoolManager's coin balances at a low value /
  // far above the real one (+2^200) and protocolFeesAccrued at 0 / 1, as the
  // copy's two-run checks do. If the bot's check FAILS with some of them
  // while the plain call completes, that assumption is what breaks it.
  // copy2-s: how many bits of its balance word does each coin count?
  // (balanceOf(PoolManager) with raw = real + 2^k, k = 40..255), its
  // totalSupply and decimals.
  // copy2-t: which USDG slots totalSupply() / balanceOf(PM) read, and does
  // eth_getProof answer them (copy 2's fills use it)?
  if (process.env.PROBE_SLOTS) {
    const tag = BLOCKS[0];
    for (const [nm, data] of [['totalSupply', ethers.id('totalSupply()').slice(0, 10)], ['balanceOf(PM)', ethers.id('balanceOf(address)').slice(0, 10) + pad(PM)], ['decimals', ethers.id('decimals()').slice(0, 10)]] as const) {
      const r = await rpc('eth_createAccessList', [{ to: USDG, data }, tag]);
      say(`USDG ${nm}: accessList ${short(r.error ?? r.result, 1500)}`);
      const list: any[] = r.result?.accessList ?? [];
      for (const e of list) {
        if (!e.storageKeys?.length) continue;
        const pr = await rpc('eth_getProof', [e.address, e.storageKeys, tag]);
        say(`  getProof ${e.address}: ${pr.error ? 'ERR ' + short(pr.error, 200) : short(pr.result.storageProof.map((x: any) => [x.key, x.value]), 1200)}`);
        for (const k of e.storageKeys) say(`  getStorageAt ${e.address} ${k} = ${(await rpc('eth_getStorageAt', [e.address, k, tag])).result}`);
      }
    }
    // Same for the stock coin.
    const r = await rpc('eth_createAccessList', [{ to: coin, data: ethers.id('totalSupply()').slice(0, 10) }, tag]);
    say(`${WANT} totalSupply accessList ${short(r.error ?? r.result, 800)}`);
    // Does totalSupply move between recent blocks?
    const latest = Number((await rpc('eth_blockNumber', [])).result);
    const seen: string[] = [];
    for (const back of [0, 50, 200, 1000, 3000]) seen.push(`${back}: ${big(await view(USDG, 'totalSupply()', '', hex(latest - back)))}`);
    say(`USDG totalSupply blocks back ${seen.join(' | ')}`);
    process.exit(0);
  }
  if (process.env.PROBE_WIDTH) {
    const tag = BLOCKS[0];
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const oz5 = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00';
    const balOf = async (c: string, ov?: Record<string, unknown>) => {
      const r = await rpc('eth_call', [{ to: c, data: ethers.id('balanceOf(address)').slice(0, 10) + pad(PM) }, tag, ...(ov ? [ov] : [])]);
      return r.error ? null : BigInt(r.result);
    };
    const places: [string, string][] = [[USDG, (slot as any).key(PM)], [coin, ethers.keccak256(abi.encode(['address', 'bytes32'], [PM, oz5]))]];
    for (const [c, sl] of places) {
      const raw = BigInt((await rpc('eth_getStorageAt', [c, sl, tag])).result);
      const real = await balOf(c);
      say(`coin ${c}: decimals ${big(await view(c, 'decimals()', '', tag))} totalSupply ${big(await view(c, 'totalSupply()', '', tag))} raw ${raw} balanceOf ${real}`);
      const ok: number[] = [], bad: number[] = [];
      for (let k = 40; k <= 255; k++) {
        const v = raw + (1n << BigInt(k));
        if (v >= 1n << 256n) break;
        const got = await balOf(c, { [c]: { stateDiff: { [sl]: '0x' + pad(hex(v)) } } });
        (got === v ? ok : bad).push(k);
        await sleep(60);
      }
      say(`  reads back raw+2^k for k in [${ok.join(',')}]; not for [${bad.join(',')}]`);
    }
    process.exit(0);
  }
  if (process.env.PROBE_OVR) {
    const tag = BLOCKS[0];
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const oz5 = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00';
    const balOf = async (c: string, h: string, ov?: Record<string, unknown>) => {
      const r = await rpc('eth_call', [{ to: c, data: ethers.id('balanceOf(address)').slice(0, 10) + pad(h) }, tag, ...(ov ? [ov] : [])]);
      return r.error ? `ERR ${short(r.error, 200)}` : BigInt(r.result).toString();
    };
    // RIVN's balance place for the PoolManager: OZ5 namespaced or slots 0..60 / Solady.
    const cands: [string, string][] = [['oz5', ethers.keccak256(abi.encode(['address', 'bytes32'], [PM, oz5]))]];
    for (let i = 0; i <= 60; i++) cands.push([`sol${i}`, ethers.keccak256(abi.encode(['address', 'uint256'], [PM, i]))]);
    let rSlot: string | null = null;
    const realR = await balOf(coin, PM);
    for (const [nm, sl] of cands) {
      const got = await balOf(coin, PM, { [coin]: { stateDiff: { [sl]: '0x' + pad(hex(777n * 10n ** 18n)) } } });
      if (got !== realR) { say(`RIVN PoolManager balance place: ${nm} ${sl}; real ${realR}; with 777e18 there balanceOf -> ${got}; raw slot ${(await rpc('eth_getStorageAt', [coin, sl, tag])).result}`); rSlot = sl; break; }
    }
    if (!rSlot) say('RIVN PoolManager balance place NOT found among oz5 / 0..60');
    const usdgSlot = (slot && 'key' in (slot as any)) ? (slot as any).key(PM) as string : null;
    const realU = BigInt(await balOf(USDG, PM));
    say(`USDG PoolManager balance place ${usdgSlot} real ${realU}`);
    // What the RIVN token reads / does: its code size, and the high value through balanceOf.
    if (rSlot) {
      for (const v of [1n << 200n, (1n << 200n) + BigInt(realR)]) say(`  RIVN balanceOf(PM) with raw ${v} -> ${await balOf(coin, PM, { [coin]: { stateDiff: { [rSlot]: '0x' + pad(hex(v)) } } })}`);
    }
    // USDG: what balanceOf says for raw stored values (does the whole word count?).
    if (usdgSlot) {
      say(`  USDG raw PM slot ${(await rpc('eth_getStorageAt', [USDG, usdgSlot, tag])).result}`);
      for (const v of [1n << 200n, (1n << 200n) + 5n, 1n << 128n, (1n << 128n) + 5n, 1n << 160n, (1n << 255n) + 5n, realU + (1n << 200n)]) {
        say(`  USDG balanceOf(PM) with raw 0x${v.toString(16)} -> ${await balOf(USDG, PM, { [USDG]: { stateDiff: { [usdgSlot]: '0x' + pad(hex(v)) } } })}`);
      }
      // A plain transfer FROM the PoolManager with those raw values.
      const tdata = new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [SIM_EXECUTOR_ADDRESS, 1000n]);
      for (const v of [realU, 1n << 200n, (1n << 200n) + 999n, (1n << 200n) + 1000n, (1n << 200n) + realU, 999n, 1000n]) {
        const r = await rpc('eth_call', [{ from: PM, to: USDG, data: tdata }, tag, { [USDG]: { stateDiff: { [usdgSlot]: '0x' + pad(hex(v)) } } }]);
        say(`  USDG transfer 1000 from PM with raw 0x${v.toString(16)}: ${r.error ? 'REVERT ' + short(r.error, 300) : 'ok'}`);
      }
    }
    const feeSlot = (c: string) => ethers.keccak256(abi.encode(['address', 'uint256'], [c, 1]));
    say(`protocolFeesAccrued RIVN ${(await rpc('eth_getStorageAt', [PM, feeSlot(coin), tag])).result} USDG ${(await rpc('eth_getStorageAt', [PM, feeSlot(USDG), tag])).result}`);
    const R = BigInt(realR.startsWith('ERR') ? '0' : realR);
    const variants: [string, { r?: bigint; u?: bigint; fee?: bigint }][] = [
      ['plain', {}], ['fee0', { fee: 0n }], ['fee1', { fee: 1n }],
      ['rivnHi', { r: R + (1n << 200n) }], ['usdgHi', { u: realU + (1n << 200n) }], ['bothHi', { r: R + (1n << 200n), u: realU + (1n << 200n) }],
      ['bothHi fee0', { r: R + (1n << 200n), u: realU + (1n << 200n), fee: 0n }], ['bothHi fee1', { r: R + (1n << 200n), u: realU + (1n << 200n), fee: 1n }],
      ['rivn 1e18', { r: 10n ** 18n }], ['usdg 1e6', { u: 10n ** 6n }], ['rivn 2^200', { r: 1n << 200n }], ['usdg 2^200', { u: 1n << 200n }],
      ['usdg 1', { u: 1n }], ['usdg 1+2^200', { u: 1n + (1n << 200n) }], ['usdg 1000', { u: 1000n }], ['usdg 1000+2^200', { u: 1000n + (1n << 200n) }],
      ['usdg 1e5', { u: 10n ** 5n }], ['usdg 1e5+2^200', { u: 10n ** 5n + (1n << 200n) }],
    ];
    const v4p = pools.find((p) => v4Of(p))!;
    for (const other of pools.filter((p) => !v4Of(p))) {
      for (const [buy, sell] of [[other, v4p], [v4p, other]]) {
        for (const usd of (process.env.PROBE_OVR_SIZES ?? '30,3000').split(',').map(Number)) {
          const built: any = buildExecuteCall({ chain: 'robinhood', tokenIn: USDG, buyPool: buy, sellPool: sell, tradeSizeUsd: usd, netProfitUsd: 1, usdPerTokenIn: 1, tokenInDecimals: 6, maxBlock: 0n } as any);
          if (built.ok === false) { say(`not built ${built.reason}`); continue; }
          const data = encodeExecuteRaw({ token: USDG, amountIn: built.amountIn, minProfit: (1n << 256n) - 1n, maxBlock: (1n << 256n) - 1n, hops: built.hops });
          const line: string[] = [];
          for (const [nm, v] of variants) {
            const ov: Record<string, any> = { [SIM_EXECUTOR_ADDRESS]: { code: ARB_EXECUTOR_RUNTIME_CODE, stateDiff: {
              ['0x' + pad(hex(EXECUTOR_STORAGE_SLOT))]: '0x' + pad(SIM_CALLER),
              ['0x' + pad(hex(V4_POOL_MANAGER_STORAGE_SLOT))]: '0x' + pad(PM),
              ['0x' + pad(hex(WETH_STORAGE_SLOT))]: '0x' + pad(ROBINHOOD_TOKENS.WETH),
            } } };
            const usdgDiff: Record<string, string> = {};
            if (slot && 'key' in (slot as any)) usdgDiff[(slot as any).key(SIM_EXECUTOR_ADDRESS)] = '0x' + pad(hex(built.amountIn));
            if (v.u !== undefined && usdgSlot) usdgDiff[usdgSlot] = '0x' + pad(hex(v.u));
            ov[USDG] = { stateDiff: usdgDiff };
            if (v.r !== undefined && rSlot) ov[coin] = { stateDiff: { [rSlot]: '0x' + pad(hex(v.r)) } };
            if (v.fee !== undefined) ov[PM] = { stateDiff: { [feeSlot(coin)]: '0x' + pad(hex(v.fee)), [feeSlot(USDG)]: '0x' + pad(hex(v.fee)) } };
            const r = await rpc('eth_call', [{ from: SIM_CALLER, to: SIM_EXECUTOR_ADDRESS, data, gas: '0x7a1200' }, tag, ov]);
            const d = typeof r.error?.data === 'string' ? r.error.data : (r.error?.data?.data ?? '');
            const tagOut = !r.error ? 'ok?!' : d.startsWith('0x4e88422a') ? `IP(${BigInt('0x' + d.slice(10, 74))})` : `${d.slice(0, 10) || 'nodata'}:${String(r.error.message).slice(0, 40)}${d.length > 10 ? ':' + d.slice(10) : ''}`;
            line.push(`${nm}=${tagOut}`);
            await sleep(120);
          }
          say(`  $${usd} ${buy.dex}${v4Of(buy) ? '' : ' ' + buy.poolAddress.slice(0, 8)} -> ${sell.dex}${v4Of(sell) ? '' : ' ' + sell.poolAddress.slice(0, 8)}: ${line.join(' | ')}`);
        }
      }
    }
    process.exit(0);
  }
  // What happened on the RIVN/USDG pools (and RIVN itself) just before each
  // mismatch block: logs are kept for old blocks even where state is not.
  if (process.env.PROBE_LOGS) {
    const names: Record<string, string> = {
      [ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')]: 'V4 Swap',
      [ethers.id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)')]: 'V4 ModifyLiquidity',
      [ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)')]: 'V3 Swap',
      [ethers.id('Mint(address,address,int24,int24,uint128,uint256,uint256)')]: 'V3 Mint',
      [ethers.id('Burn(address,int24,int24,uint128,uint256,uint256)')]: 'V3 Burn',
      [ethers.id('Collect(address,address,int24,int24,uint128,uint128)')]: 'V3 Collect',
      [ethers.id('Transfer(address,address,uint256)')]: 'Transfer',
    };
    const v4ids = pools.filter((p) => v4Of(p)).map((p) => p.poolAddress.toLowerCase());
    const v3s = pools.filter((p) => !v4Of(p)).map((p) => p.poolAddress.toLowerCase());
    const back = Number(process.env.PROBE_LOGS);
    for (const b of MISMATCH_BLOCKS.split(',')) {
      const n = parseInt(b, 16);
      say(`== logs ${n - back}..${n + 2} (mismatch block ${n})`);
      const r = await rpc('eth_getLogs', [{ address: [PM, coin, ...v3s], fromBlock: hex(n - back), toBlock: hex(n + 2) }]);
      if (r.error) { say(`  ERR ${short(r.error, 160)}`); continue; }
      for (const l of r.result ?? []) {
        const a = String(l.address).toLowerCase();
        const nm = names[l.topics[0]] ?? l.topics[0].slice(0, 10);
        if (a === PM && !v4ids.includes(String(l.topics[1]).toLowerCase())) continue;
        if (a === coin && nm === 'Transfer') {
          const from = '0x' + String(l.topics[1]).slice(26), to = '0x' + String(l.topics[2]).slice(26);
          say(`  ${parseInt(l.blockNumber, 16)}/${parseInt(l.logIndex, 16)} RIVN Transfer ${from.slice(0, 10)} -> ${to.slice(0, 10)} ${BigInt(l.data)} tx ${String(l.transactionHash).slice(0, 12)}`);
          continue;
        }
        if (a === coin) { say(`  ${parseInt(l.blockNumber, 16)} RIVN event ${nm} topics ${short(l.topics.slice(1), 200)} data ${String(l.data).slice(0, 200)}`); continue; }
        say(`  ${parseInt(l.blockNumber, 16)}/${parseInt(l.logIndex, 16)} ${a === PM ? 'v4' : a.slice(0, 10)} ${nm} ${short(l.topics.slice(2), 140)} data ${String(l.data).slice(2).match(/.{64}/g)?.map((w: string) => { const v = BigInt('0x' + w); return v > (1n << 255n) ? '-' + ((1n << 256n) - v).toString() : v.toString(); }).join(' ')} tx ${String(l.transactionHash).slice(0, 12)}`);
      }
    }
    process.exit(0);
  }
  const sizes = (process.env.PROBE_SIZES ?? '30,100,300,1000,3000').split(',').map(Number);
  type Hit = { b: string; buy: PoolState; sell: PoolState; usd: number; amountIn: bigint; hops: any[]; status: string; gas: number; reason: string };
  const hits: Hit[] = [];
  for (const b of BLOCKS) {
    say(`== block ${b}: PoolManager holds ${coin.slice(0, 8)} ${await view(coin, 'balanceOf(address)', pad(PM), b)} USDG ${await view(USDG, 'balanceOf(address)', pad(PM), b)}`);
    for (const buy of pools) for (const sell of pools) {
      if (buy === sell) continue;
      for (const usd of sizes) {
        const built: any = buildExecuteCall({ chain: 'robinhood', tokenIn: USDG, buyPool: buy, sellPool: sell, tradeSizeUsd: usd, netProfitUsd: 1, usdPerTokenIn: 1, tokenInDecimals: 6, maxBlock: 0n } as any);
        if (!built.ok && 'reason' in built) { say(`  ${buy.dex}->${sell.dex}: not built (${built.reason})`); break; }
        const r: any = await simulateRoundTrip(rpc, 'robinhood', { token: USDG, amountIn: built.amountIn, hops: built.hops }, { weth: ROBINHOOD_TOKENS.WETH, blockTag: b });
        const gas = r.gasUsed !== undefined ? Number(r.gasUsed) : -1;
        say(`  $${usd} ${buy.dex}${v4Of(buy) ? '/' + v4Of(buy)!.fee : ''} -> ${sell.dex}${v4Of(sell) ? '/' + v4Of(sell)!.fee : ''}: ${r.status}${r.reason ? ' (' + String(r.reason).slice(0, 90) + ')' : ''} gas ${gas}`);
        hits.push({ b, buy, sell, usd, amountIn: built.amountIn, hops: built.hops, status: r.status, gas, reason: r.reason ?? '' });
        await sleep(250);
      }
    }
  }
  // The loss checks closest to the copy's gas: what they did, and every value they read.
  const near = hits.filter((h) => h.status === 'loss' && h.gas > 0).sort((x, y) => Math.abs(x.gas - COPY_GAS) - Math.abs(y.gas - COPY_GAS)).slice(0, Number(process.env.PROBE_TRACES ?? 2));
  for (const h of near) {
    say(`== trace: block ${h.b} $${h.usd} ${h.buy.dex} -> ${h.sell.dex} (node gas ${h.gas})`);
    const data = encodeExecuteRaw({ token: USDG, amountIn: h.amountIn, minProfit: (1n << 256n) - 1n, maxBlock: (1n << 256n) - 1n, hops: h.hops });
    const ov: Record<string, any> = { [SIM_EXECUTOR_ADDRESS]: { code: ARB_EXECUTOR_RUNTIME_CODE, stateDiff: {
      ['0x' + pad(hex(EXECUTOR_STORAGE_SLOT))]: '0x' + pad(SIM_CALLER),
      ['0x' + pad(hex(V4_POOL_MANAGER_STORAGE_SLOT))]: '0x' + pad(PM),
      ['0x' + pad(hex(WETH_STORAGE_SLOT))]: '0x' + pad(ROBINHOOD_TOKENS.WETH),
    } } };
    if (slot && 'key' in (slot as any)) ov[USDG] = { stateDiff: { [(slot as any).key(SIM_EXECUTOR_ADDRESS)]: '0x' + pad(hex(h.amountIn)) } };
    const call = { from: SIM_CALLER, to: SIM_EXECUTOR_ADDRESS, data, gas: '0x7a1200' };
    const t = await rpc('debug_traceCall', [call, h.b, { tracer: 'callTracer', stateOverrides: ov }]);
    if (t.error) { say(`  callTracer: ${short(t.error, 200)}`); continue; }
    const walk = (c: any, d: number) => { say(`  ${'  '.repeat(d)}${c.type} ${c.to} ${String(c.input).slice(0, 10)} gas ${parseInt(c.gasUsed, 16)}${c.error ? ` ERROR ${c.error}` : ''}${c.output && (c.error || d > 0) ? ` out ${String(c.output).slice(0, 138)}` : ''}`); (c.calls ?? []).forEach((x: any) => walk(x, d + 1)); };
    walk(t.result, 0);
    const pre = await rpc('debug_traceCall', [call, h.b, { tracer: 'prestateTracer', stateOverrides: ov }]);
    if (pre.error) { say(`  prestateTracer: ${short(pre.error, 200)}`); continue; }
    for (const [a, acct] of Object.entries<any>(pre.result ?? {})) {
      const st = Object.entries<any>(acct.storage ?? {});
      const isPm = a.toLowerCase() === PM;
      say(`  reads ${a} (${st.length} slots${acct.code ? `, code ${(acct.code.length - 2) / 2} bytes` : ''})`);
      // The PoolManager: only its non-pool slots (pool slots are many).
      for (const [k, v] of st.slice(0, isPm ? 0 : 40)) say(`    ${k} = ${v}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.log('probe crashed: ' + (e as Error).stack); process.exit(0); });
