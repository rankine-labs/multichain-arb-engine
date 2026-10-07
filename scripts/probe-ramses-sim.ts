// ============================================================================
// RAMSES SIM PROBE -- runs the bot's own check (simulateRoundTrip) on the
// live node for the route that keeps failing (Uniswap V3 <-> Ramses V3 on
// WETH/USDG), next to a control route without Ramses, and asks the node to
// trace where the failing one reverts. Read-only, no keys.
// ============================================================================
import { makeRpc, simulateRoundTrip, SIM_EXECUTOR_ADDRESS, SIM_CALLER, replayRpc, ReplayCall } from '../src/execution/simulator';
import { KIND_V3, encodeExecuteRaw } from '../src/execution/executorCalldata';
import { ARB_EXECUTOR_RUNTIME_CODE, EXECUTOR_STORAGE_SLOT } from '../src/execution/arbExecutorBytecode';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const RAMSES = '0x028779ca5d91c7f016acb98e0afa5102f4e436e4';
const UNI_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const CAKE_FACTORY = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';

const base = makeRpc(URL_, 15_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Retry on public-node rate limits.
const rpc = async (m: string, p: unknown[]) => { for (let i = 0; i < 5; i++) { const r = await base(m, p); if (!r.error || !/429|too many|rate/i.test(JSON.stringify(r.error))) return r; await sleep(2000 * (i + 1)); } return base(m, p); };
// The replay as it was before the fix (no block overrides), for comparison.
const replayRpcNoOverrides = (b: typeof base, parent: string, prefix: ReplayCall[]) => async (m: string, p: unknown[]) => {
  const q = p as any[];
  if (m !== 'eth_call' || q[0]?.to?.toLowerCase() !== SIM_EXECUTOR_ADDRESS) return rpc(m, p);
  const r = await rpc('eth_simulateV1', [{ blockStateCalls: [{ stateOverrides: q[2] ?? {}, calls: [...prefix, q[0]] }], validation: false }, parent]);
  if (r.error) return { error: { message: 'replay unavailable' } };
  const c = r.result?.[0]?.calls ?? []; const o = c[c.length - 1];
  return o?.status === '0x1' ? { result: o.returnData } : { error: { message: o?.error?.message ?? 'execution reverted', data: o?.returnData } };
};
const pad = (a: string) => a.replace(/^0x/, '').padStart(64, '0');

async function getPool(factory: string, fee: number): Promise<string | null> {
  const r = await rpc('eth_call', [{ to: factory, data: '0x1698ee82' + pad(WETH) + pad(USDG) + fee.toString(16).padStart(64, '0') }, 'latest']);
  const a = r.result ? '0x' + String(r.result).slice(26) : null;
  return a && !/^0x0+$/.test(a) ? a : null;
}

(async () => {
  let uni: string | null = null;
  for (const f of [500, 100, 3000, 10000]) { const p = await getPool(UNI_FACTORY, f); if (p && p.startsWith('0x52e65b17')) uni = p; }
  uni ??= await getPool(UNI_FACTORY, 500);
  const cake = await getPool(CAKE_FACTORY, 500) ?? await getPool(CAKE_FACTORY, 2500);
  console.log(`uni pool ${uni}, cake pool ${cake}, ramses pool ${RAMSES}`);
  const amountIn = 10n ** 17n; // 0.1 WETH (~$350), like the failing checks (under $1k)
  const hop = (pool: string, a: string, b: string) => ({ kind: KIND_V3, pool, tokenIn: a, tokenOut: b, feeBps: 0 });
  const routes: [string, any[]][] = [
    ['control uni->cake', [hop(uni!, WETH, USDG), hop(cake!, USDG, WETH)]],
    ['uni->ramses', [hop(uni!, WETH, USDG), hop(RAMSES, USDG, WETH)]],
    ['ramses->uni', [hop(RAMSES, WETH, USDG), hop(uni!, USDG, WETH)]],
  ];
  for (const [label, hops] of routes) {
    const r = await simulateRoundTrip(rpc, 'robinhood', { token: WETH, amountIn, hops });
    console.log(`${label}: ${r.status}${'reason' in r ? ` (${r.reason})` : ''}`);
    await sleep(1500);
  }
  // Replay mode (what the bot's checks use): recent block's trades, then ours.
  // Old way (no block overrides) vs new (real block time + big gas room).
  const latest = Number((await rpc('eth_blockNumber', [])).result);
  for (let n = latest - 3; n > latest - 120; n--) {
    const b = (await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), true])).result;
    const txs: any[] = (b?.transactions ?? []).filter((t: any) => t.to && ['0x0', '0x1', '0x2'].includes(t.type));
    if (!txs.length) continue;
    const prefix: ReplayCall[] = txs.map((t) => ({ from: t.from, to: t.to, data: t.input, value: t.value, gas: t.gas }));
    console.log(`replay block ${n}: ${prefix.length} trade(s), gas limits ${prefix.map((x) => parseInt(x.gas!, 16)).join(', ')}`);
    for (const [label, hops] of routes) {
      const oldWay = await simulateRoundTrip(replayRpcNoOverrides(base, '0x' + (n - 1).toString(16), prefix), 'robinhood', { token: WETH, amountIn, hops });
      const newWay = await simulateRoundTrip(replayRpc(rpc, '0x' + (n - 1).toString(16), prefix, b.timestamp), 'robinhood', { token: WETH, amountIn, hops });
      console.log(`  ${label}: old replay ${oldWay.status}${'reason' in oldWay ? ` (${oldWay.reason})` : ''} | new replay ${newWay.status}${'reason' in newWay ? ` (${newWay.reason})` : ''}`);
      await sleep(1000);
    }
    break;
  }
  // Trace the Ramses route: where does it revert?
  const data = encodeExecuteRaw({ token: WETH, amountIn, minProfit: (1n << 256n) - 1n, maxBlock: (1n << 256n) - 1n, hops: routes[1][1] });
  const balKey = (await import('ethers')).ethers.keccak256((await import('ethers')).ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [SIM_EXECUTOR_ADDRESS, 3]));
  const overrides = {
    [SIM_EXECUTOR_ADDRESS]: { code: ARB_EXECUTOR_RUNTIME_CODE, stateDiff: { ['0x' + pad('0x' + EXECUTOR_STORAGE_SLOT.toString(16))]: '0x' + pad(SIM_CALLER) } },
    [WETH]: { stateDiff: { [balKey]: '0x' + amountIn.toString(16).padStart(64, '0') } },
  };
  const t = await rpc('debug_traceCall', [{ from: SIM_CALLER, to: SIM_EXECUTOR_ADDRESS, data, gas: '0x7a1200' }, 'latest', { tracer: 'callTracer', stateOverrides: overrides }]);
  if (t.error) { console.log(`trace: not available (${JSON.stringify(t.error).slice(0, 120)})`); return; }
  // Print the call tree, deepest failing call first.
  const lines: string[] = [];
  const walk = (c: any, d: number) => { lines.push(`${'  '.repeat(d)}${c.type} ${c.to} ${String(c.input).slice(0, 10)} gas ${parseInt(c.gasUsed, 16)}${c.error ? ` ERROR ${c.error}` : ''}${c.revertReason ? ` (${c.revertReason})` : ''}${c.output && c.error ? ` out ${String(c.output).slice(0, 74)}` : ''}`); (c.calls ?? []).forEach((x: any) => walk(x, d + 1)); };
  walk(t.result, 0);
  console.log('trace (WETH balance slot 3 assumed):');
  for (const l of lines.slice(0, 40)) console.log(l);
})();
