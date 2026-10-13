// ============================================================================
// NVDA PROBE -- why does every practice check on USDG/NVDA "break"?
//
// Plain English: the status page shows ~140 failed checks an hour, all on
// USDG/NVDA (a tokenized stock). This script looks at the NVDA token and its
// pools on the live node and prints what it finds:
//   1. the token contract: is it a proxy, which functions does it have
//      (pause / allowlist / market-hours style), what do they say right now
//   2. can NVDA actually move: pretend each pool sends a little NVDA to our
//      check contract and to a random address (plain eth_call, no keys)
//   3. the pools: price, liquidity and real balances, next to the model gap
//   4. the bot's own check (simulateRoundTrip) on the failing routes, plus a
//      call trace so we can see which call reverts and why
// Read-only. No keys, no transactions.
// ============================================================================
import { ethers } from 'ethers';
import { makeRpc, simulateRoundTrip, SIM_EXECUTOR_ADDRESS, SIM_CALLER, findBalanceSlot } from '../src/execution/simulator';
import { buildExecuteCall } from '../src/execution/executorCalldata';
import { ARB_EXECUTOR_RUNTIME_CODE, EXECUTOR_STORAGE_SLOT, FLASH_POOLS_STORAGE_SLOT, V4_POOL_MANAGER_STORAGE_SLOT, WETH_STORAGE_SLOT } from '../src/execution/arbExecutorBytecode';
import { discoverPairPools, Venue } from '../src/core/pairWatcher';
import { findStandingGaps } from '../src/core/gapScanner';
import { ROBINHOOD_TOKENS, ROBINHOOD_V3, ROBINHOOD_RAMSES, ROBINHOOD_V4 } from '../src/config/knownAddresses';
import { PoolState } from '../src/core/types';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const NVDA = (process.env.PROBE_TOKEN ?? '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC').toLowerCase();
const USDG = ROBINHOOD_TOKENS.USDG.toLowerCase();
const provider = new ethers.JsonRpcProvider(URL_, 4663, { staticNetwork: true });
const base = makeRpc(URL_, 15_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Retry on public-node rate limits.
const rpc = async (m: string, p: unknown[]) => { for (let i = 0; i < 5; i++) { const r = await base(m, p); if (!r.error || !/429|too many|rate|network:/i.test(JSON.stringify(r.error))) return r; await sleep(2000 * (i + 1)); } return base(m, p); };
const pad = (a: string) => a.replace(/^0x/, '').padStart(64, '0');
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };
const short = (x: unknown) => JSON.stringify(x).slice(0, 220);

// eth_call a function by its text signature with no arguments (or raw data).
async function view(to: string, sig: string, args = '', from?: string): Promise<string> {
  const data = ethers.id(sig).slice(0, 10) + args;
  const r = await rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
  return r.error ? `ERR ${short(r.error)}` : String(r.result);
}

// Every 4-byte function id the contract's code pushes (PUSH4 = 0x63).
function selectorsIn(code: string): Set<string> {
  const b = ethers.getBytes(code);
  const s = new Set<string>();
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op === 0x63 && i + 4 < b.length) s.add('0x' + Buffer.from(b.slice(i + 1, i + 5)).toString('hex'));
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // skip push data
  }
  return s;
}

// Names we want to recognise in the token's code (restriction-type functions).
const KNOWN = [
  'paused()', 'pause()', 'unpause()', 'isPaused()', 'owner()', 'admin()', 'getRoleAdmin(bytes32)', 'hasRole(bytes32,address)',
  'isAllowed(address)', 'isAllowlisted(address)', 'allowlist(address)', 'whitelist(address)', 'isWhitelisted(address)',
  'isBlacklisted(address)', 'blacklist(address)', 'isBlocked(address)', 'isFrozen(address)', 'frozen(address)', 'isSanctioned(address)',
  'tradingOpen()', 'tradingEnabled()', 'isTradingOpen()', 'marketOpen()', 'isMarketOpen()', 'transfersEnabled()', 'transferable()',
  'complianceModule()', 'compliance()', 'identityRegistry()', 'canTransfer(address,address,uint256)', 'isTransferAllowed(address,address,uint256)',
  'detectTransferRestriction(address,address,uint256)', 'messageForTransferRestriction(uint8)', 'restrictor()', 'transferRestrictor()',
  'oracle()', 'priceOracle()', 'multiplier()', 'sharesMultiplier()', 'balanceOfShares(address)', 'sharesOf(address)', 'totalShares()',
  'implementation()', 'proxiableUUID()', 'upgradeTo(address)', 'upgradeToAndCall(address,bytes)', 'name()', 'symbol()', 'decimals()',
  'totalSupply()', 'balanceOf(address)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)',
  'isHoliday()', 'marketHours()', 'tradingHours()', 'halted()', 'isHalted()', 'globalPause()', 'pausedTransfers()', 'transfersPaused()',
  'version()', 'eip712Domain()', 'nonces(address)', 'DOMAIN_SEPARATOR()', 'mint(address,uint256)', 'burn(address,uint256)', 'burn(uint256)',
  'rebase()', 'getShares(uint256)', 'getAmount(uint256)', 'convertToShares(uint256)', 'convertToAssets(uint256)', 'asset()', 'underlying()',
];
const KNOWN_BY_SEL = new Map(KNOWN.map((k) => [ethers.id(k).slice(0, 10), k]));

async function tokenSection() {
  say(`== token ${NVDA}`);
  const code = String((await rpc('eth_getCode', [NVDA, 'latest'])).result ?? '0x');
  say(`code size ${(code.length - 2) / 2} bytes`);
  const implSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const beaconSlot = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
  const adminSlot = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
  const word = async (slot: string) => String((await rpc('eth_getStorageAt', [NVDA, slot, 'latest'])).result ?? '0x');
  const impl = '0x' + (await word(implSlot)).slice(-40);
  const beacon = '0x' + (await word(beaconSlot)).slice(-40);
  const admin = '0x' + (await word(adminSlot)).slice(-40);
  say(`EIP-1967 impl ${impl} beacon ${beacon} admin ${admin}`);
  let logic = /^0x0+$/.test(impl) ? null : impl;
  if (!logic && !/^0x0+$/.test(beacon)) {
    const r = await view(beacon, 'implementation()');
    if (!r.startsWith('ERR')) logic = '0x' + r.slice(-40);
  }
  // EIP-1167 minimal proxy
  const m = code.match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af4/i);
  if (!logic && m) logic = '0x' + m[1];
  const logicCode = logic ? String((await rpc('eth_getCode', [logic, 'latest'])).result ?? '0x') : code;
  say(`logic contract ${logic ?? '(token itself)'} size ${(logicCode.length - 2) / 2} bytes`);
  const sels = selectorsIn(logicCode);
  const named = [...sels].map((s) => KNOWN_BY_SEL.get(s)).filter(Boolean);
  const unnamed = [...sels].filter((s) => !KNOWN_BY_SEL.has(s));
  say(`functions recognised: ${named.join(' ')}`);
  say(`other 4-byte ids (${unnamed.length}): ${unnamed.join(' ')}`);
  // Which proxy code is in the token itself (non-proxy: same as above).
  if (logic) say(`proxy's own ids: ${[...selectorsIn(code)].map((s) => KNOWN_BY_SEL.get(s) ?? s).join(' ')}`);
  for (const f of ['name()', 'symbol()', 'decimals()', 'totalSupply()', 'paused()', 'isPaused()', 'owner()', 'tradingOpen()', 'isMarketOpen()', 'marketOpen()', 'transfersPaused()', 'halted()', 'multiplier()', 'sharesMultiplier()', 'oracle()', 'compliance()', 'complianceModule()', 'restrictor()', 'transferRestrictor()', 'version()']) {
    if (!sels.has(ethers.id(f).slice(0, 10))) continue;
    say(`  ${f} -> ${(await view(NVDA, f)).slice(0, 200)}`);
  }
  // Allowlist-type views on our check contract and a random address.
  for (const f of ['isAllowed(address)', 'isAllowlisted(address)', 'isWhitelisted(address)', 'isBlacklisted(address)', 'isBlocked(address)', 'isFrozen(address)', 'frozen(address)', 'isSanctioned(address)']) {
    if (!sels.has(ethers.id(f).slice(0, 10))) continue;
    say(`  ${f} sim-contract -> ${await view(NVDA, f, pad(SIM_EXECUTOR_ADDRESS))} | random -> ${await view(NVDA, f, pad('0x1111111111111111111111111111111111111111'))}`);
  }
  for (const f of ['canTransfer(address,address,uint256)', 'isTransferAllowed(address,address,uint256)', 'detectTransferRestriction(address,address,uint256)']) {
    if (!sels.has(ethers.id(f).slice(0, 10))) continue;
    say(`  ${f} -> ${await view(NVDA, f, pad(SIM_CALLER) + pad(SIM_EXECUTOR_ADDRESS) + pad('0x' + (10n ** 15n).toString(16)))}`);
  }
  // Recent Transfer events: is NVDA moving at all right now?
  const latest = Number((await rpc('eth_blockNumber', [])).result);
  const topic = ethers.id('Transfer(address,address,uint256)');
  for (const span of [2_000, 20_000, 120_000]) {
    const logs = await rpc('eth_getLogs', [{ address: NVDA, topics: [topic], fromBlock: '0x' + (latest - span).toString(16), toBlock: '0x' + latest.toString(16) }]);
    if (logs.error) { say(`transfers in last ${span} blocks: ERR ${short(logs.error)}`); continue; }
    const arr: any[] = logs.result ?? [];
    say(`transfers in last ${span} blocks (~${Math.round(span * 0.03 / 60)} min at ~30 ms/block?): ${arr.length}${arr.length ? `, newest block ${parseInt(arr[arr.length - 1].blockNumber, 16)} (latest ${latest})` : ''}`);
    if (arr.length) {
      const b = await rpc('eth_getBlockByNumber', [arr[arr.length - 1].blockNumber, false]);
      const lb = await rpc('eth_getBlockByNumber', ['0x' + latest.toString(16), false]);
      say(`  newest transfer at ${new Date(parseInt(b.result?.timestamp, 16) * 1000).toISOString()}, now ${new Date(parseInt(lb.result?.timestamp, 16) * 1000).toISOString()}`);
      break;
    }
  }
  return { sels, logic };
}

// Pretend `from` sends `amt` NVDA to `to` (plain eth_call, nothing is sent).
async function tryTransfer(label: string, from: string, to: string, amt: bigint) {
  const data = new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [to, amt]);
  const r = await rpc('eth_call', [{ from, to: NVDA, data, gas: '0x2dc6c0' }, 'latest']);
  let reason = '';
  if (r.error) {
    const d = typeof r.error.data === 'string' ? r.error.data : (r.error.data?.data ?? '');
    try { if (d && d.startsWith('0x08c379a0')) reason = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + d.slice(10))[0]; } catch { /* keep raw */ }
    say(`  ${label}: REVERT ${short(r.error).slice(0, 200)}${reason ? ` reason="${reason}"` : ''}`);
  } else say(`  ${label}: ok (${String(r.result).slice(0, 66)})`);
}

(async () => {
  const { sels } = await tokenSection();
  const decNvda = Number(BigInt(await view(NVDA, 'decimals()')));
  const decUsdg = Number(BigInt(await view(USDG, 'decimals()')));
  say(`decimals NVDA ${decNvda}, USDG ${decUsdg}`);

  // Pools, found the way the bot finds them.
  const venues: Venue[] = [
    { dex: 'uniswap-v3', kind: 'v3-fee', factory: ROBINHOOD_V3.FACTORY },
    { dex: 'ramses-v3', kind: 'v3-spacing', factory: ROBINHOOD_RAMSES.V3_FACTORY },
    { dex: 'uniswap-v4', kind: 'v4', factory: ROBINHOOD_V4.STATE_VIEW, poolManager: ROBINHOOD_V4.POOL_MANAGER, weth: ROBINHOOD_TOKENS.WETH },
  ];
  const pools = await discoverPairPools(provider, 'robinhood', venues, USDG, NVDA);
  const decOf = (t: string) => (t.toLowerCase() === NVDA ? decNvda : t.toLowerCase() === USDG ? decUsdg : undefined);
  say(`== pools (${pools.length})`);
  // Unreadable answer -> -1 (printed as such) instead of crashing the probe.
  const big = (x: string) => { try { return BigInt(x.slice(0, 66)); } catch { return -1n; } };
  const nvdaBal = async (holder: string) => big(await view(NVDA, 'balanceOf(address)', pad(holder)));
  const usdgBal = async (holder: string) => big(await view(USDG, 'balanceOf(address)', pad(holder)));
  for (const p of pools) {
    const a0 = p.tokenA.toLowerCase();
    const raw = Number(p.sqrtPriceX96 ?? 0n) / 2 ** 96;
    // price of tokenB per tokenA, decimal-adjusted, then USDG per NVDA
    const bPerA = raw * raw * 10 ** ((decOf(p.tokenA) ?? 0) - (decOf(p.tokenB) ?? 0));
    const usdgPerNvda = a0 === USDG ? 1 / bPerA : bPerA;
    const holder = p.v4 ? p.v4.poolManager : p.poolAddress;
    if (!p.v4) {
      const s0 = await view(p.poolAddress, 'slot0()');
      const ts = await view(p.poolAddress, 'tickSpacing()');
      say(`  (${p.poolAddress} tick ${s0.startsWith('0x') ? ethers.AbiCoder.defaultAbiCoder().decode(['int24'], '0x' + s0.slice(66, 130))[0] : s0} spacing ${ts.startsWith('0x') ? BigInt(ts) : ts})`);
    } else say(`  (v4 id ${p.poolAddress} fee ${p.v4.fee} spacing ${p.v4.tickSpacing})`);
    say(`${p.dex} ${(p.feePips ?? p.feeBps * 100) / 10_000}% ${p.poolAddress.slice(0, 18)} tokenA=${p.tokenA.slice(0, 8)} USDG/NVDA=${usdgPerNvda.toFixed(4)} L=${p.liquidity} holds NVDA ${Number(await nvdaBal(holder)) / 10 ** decNvda} USDG ${Number(await usdgBal(holder)) / 10 ** decUsdg}${p.v4 ? ' (PoolManager total)' : ''}`);
  }
  // Model gap, same scanner as the bot (NVDA $ price taken from the pools).
  const uniPrice = (() => { const p = pools.find((x) => x.dex === 'uniswap-v3'); if (!p) return 0; const raw = Number(p.sqrtPriceX96) / 2 ** 96; const bpa = raw * raw * 10 ** ((decOf(p.tokenA) ?? 0) - (decOf(p.tokenB) ?? 0)); return p.tokenA.toLowerCase() === USDG ? 1 / bpa : bpa; })();
  const usdOf = (t: string) => (t.toLowerCase() === USDG ? 1 : t.toLowerCase() === NVDA ? uniPrice : null);
  const gaps = findStandingGaps([pools.filter((p) => !p.v4?.hooks)], decOf, usdOf, { minProfitUsd: 0.1, flashFee: 0, gasUsd: 0.01, maxTradeUsd: 20_000, perPair: 6 });
  say(`== model gaps (${gaps.length})`);
  for (const g of gaps) say(`  buy ${g.buyPool.dex} ${g.buyPool.feeBps / 100}% -> sell ${g.sellPool.dex} ${g.sellPool.feeBps / 100}% model $${g.profitUsd.toFixed(2)} size $${g.sizeUsd.toFixed(0)} start ${g.quote === NVDA ? 'NVDA' : 'USDG'}`);

  // Can NVDA move? Each pool sends a little to our check contract / a random EOA.
  say('== NVDA transfer tests (eth_call, nothing sent)');
  const small = 10n ** BigInt(Math.max(decNvda - 3, 0)); // 0.001 NVDA
  for (const p of pools.slice(0, 6)) {
    const holder = p.v4 ? p.v4.poolManager : p.poolAddress;
    await tryTransfer(`${p.dex} ${p.feeBps / 100}% -> sim contract`, holder, SIM_EXECUTOR_ADDRESS, small);
    await tryTransfer(`${p.dex} ${p.feeBps / 100}% -> random EOA`, holder, '0x1111111111111111111111111111111111111111', small);
  }
  // USDG control: same move with USDG from the first pool.
  if (pools[0]) {
    const holder = pools[0].v4 ? pools[0].v4.poolManager : pools[0].poolAddress;
    const data = new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [SIM_EXECUTOR_ADDRESS, 10n ** BigInt(decUsdg - 2)]);
    const r = await rpc('eth_call', [{ from: holder, to: USDG, data }, 'latest']);
    say(`  control USDG pool -> sim contract: ${r.error ? 'REVERT ' + short(r.error) : 'ok'}`);
  }

  // Balance slot lookup (own-money checks starting with NVDA).
  try {
    const slot = await findBalanceSlot(rpc, 'robinhood:' + NVDA, NVDA);
    say(`== NVDA balance slot lookup: ${slot === null ? 'NOT FOUND' : 'key' in (slot as any) ? 'found' : short(slot)}`);
  } catch (e) { say(`== NVDA balance slot lookup: error ${(e as Error).message}`); }
  try {
    const slot = await findBalanceSlot(rpc, 'robinhood:' + USDG, USDG);
    say(`   USDG balance slot lookup: ${slot === null ? 'NOT FOUND' : 'found'}`);
  } catch (e) { say(`   USDG balance slot lookup: error ${(e as Error).message}`); }

  // The bot's own check on the failing routes (sell on Uniswap V3 0.01%).
  say('== bot check (simulateRoundTrip), flash loan where a lender exists, else own money');
  const sell = pools.find((p) => p.dex === 'uniswap-v3' && p.feeBps === 1);
  const lenderFor = (skip: string[]) => pools.find((p) => p.dex === 'uniswap-v3' && !p.v4 && !skip.includes(p.poolAddress));
  const routes = gaps.length ? gaps.map((g) => [g.buyPool, g.sellPool, g.quote] as const)
    : pools.filter((p) => p !== sell).map((b) => [b, sell!, USDG] as const);
  for (const [buy, sellP, start] of routes.slice(0, 6)) {
    if (!buy || !sellP) continue;
    const startDec = start === NVDA ? decNvda : decUsdg;
    const usdPer = start === NVDA ? uniPrice : 1;
    for (const funding of ['own', 'flash'] as const) {
      const lender = funding === 'flash' ? lenderFor([buy.poolAddress, sellP.poolAddress]) : undefined;
      if (funding === 'flash' && !lender) continue;
      const built = buildExecuteCall({ chain: 'robinhood', tokenIn: start, buyPool: buy, sellPool: sellP, tradeSizeUsd: 500, netProfitUsd: 1, usdPerTokenIn: usdPer, tokenInDecimals: startDec, maxBlock: 0n, v3Lender: lender?.poolAddress });
      if ('reason' in built) { say(`  ${buy.dex}->${sellP.dex}: not built (${built.reason})`); continue; }
      const r = await simulateRoundTrip(rpc, 'robinhood', { token: start, amountIn: built.amountIn, hops: built.hops }, { v3Lender: lender?.poolAddress, weth: ROBINHOOD_TOKENS.WETH });
      say(`  start ${start === NVDA ? 'NVDA' : 'USDG'} $500 buy ${buy.dex} ${buy.feeBps / 100}% -> sell ${sellP.dex} ${sellP.feeBps / 100}% [${funding}]: ${r.status}${'reason' in r ? ` (${r.reason})` : ''}${r.status === 'profit' ? ` ${Number(r.profit) / 10 ** startDec}` : ''}`);
      await sleep(800);
      // Trace the first failing one: which call reverts?
      if (r.status === 'fail' && !(globalThis as any).__traced) {
        (globalThis as any).__traced = true;
        const { encodeExecuteRaw, encodeExecuteV3FlashRaw } = await import('../src/execution/executorCalldata');
        const args = { token: start, amountIn: built.amountIn, minProfit: (1n << 256n) - 1n, maxBlock: (1n << 256n) - 1n, hops: built.hops };
        const data = lender ? encodeExecuteV3FlashRaw(args, lender.poolAddress) : encodeExecuteRaw(args);
        const ov: Record<string, any> = { [SIM_EXECUTOR_ADDRESS]: { code: ARB_EXECUTOR_RUNTIME_CODE, stateDiff: { ['0x' + pad('0x' + EXECUTOR_STORAGE_SLOT.toString(16))]: '0x' + pad(SIM_CALLER) } } };
        if (!lender) {
          const slot = await findBalanceSlot(rpc, 'robinhood:' + start, start);
          if (slot && 'key' in slot) ov[start] = { stateDiff: { [slot.key(SIM_EXECUTOR_ADDRESS)]: '0x' + pad('0x' + built.amountIn.toString(16)) } };
        } else {
          // allow the lender (FLASH_POOLS mapping) like the simulator does
          ov[SIM_EXECUTOR_ADDRESS].stateDiff[ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [lender.poolAddress, FLASH_POOLS_STORAGE_SLOT]))] = '0x' + pad('0x1');
        }
        // V4 switched on (PoolManager + WETH), as the simulator does for V4 hops
        ov[SIM_EXECUTOR_ADDRESS].stateDiff['0x' + pad('0x' + V4_POOL_MANAGER_STORAGE_SLOT.toString(16))] = '0x' + pad(ROBINHOOD_V4.POOL_MANAGER);
        ov[SIM_EXECUTOR_ADDRESS].stateDiff['0x' + pad('0x' + WETH_STORAGE_SLOT.toString(16))] = '0x' + pad(ROBINHOOD_TOKENS.WETH);
        const t = await rpc('debug_traceCall', [{ from: SIM_CALLER, to: SIM_EXECUTOR_ADDRESS, data, gas: '0x7a1200' }, 'latest', { tracer: 'callTracer', stateOverrides: ov }]);
        if (t.error) { say(`  trace: not available (${short(t.error).slice(0, 120)})`); continue; }
        const lines: string[] = [];
        const walk = (c: any, d: number) => { lines.push(`${'  '.repeat(d)}${c.type} ${c.to} ${String(c.input).slice(0, 10)}${c.error ? ` ERROR ${c.error}` : ''}${c.revertReason ? ` (${c.revertReason})` : ''}${c.error && c.output ? ` out ${String(c.output).slice(0, 140)}` : ''}`); (c.calls ?? []).forEach((x: any) => walk(x, d + 1)); };
        walk(t.result, 0);
        say('  trace:');
        for (const l of lines.slice(0, 40)) say('    ' + l);
      }
    }
  }
  void sels;
  process.exit(0);
})().catch((e) => { console.log('probe crashed: ' + (e as Error).stack); process.exit(0); });
