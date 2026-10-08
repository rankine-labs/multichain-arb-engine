// ============================================================================
// RIVAL REPLAY: NODE CAPABILITY CHECK (research, read-only)
//
// Plain English:
//   Before replaying competitor trades we need to know which "questions" the
//   public Robinhood node will answer: exact traces of where ETH moved
//   (debug_traceTransaction), old balances (eth_getBalance at a past block),
//   ordered replays (eth_simulateV1), event searches over long ranges
//   (eth_getLogs), and so on. This script asks each one once, against a real
//   competitor trade, and prints OK / FAIL with the node's answer.
//   It also prints a few long test messages, so we can see how much text a
//   GitHub annotation keeps (the only way results come back to us).
//
// Nothing is sent or signed. Calls are spaced ~650 ms apart (the public node
// blocks bursts).
// ============================================================================

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const PACE_MS = Number(process.env.PROBE_PACE_MS ?? 650);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One JSON-RPC request, paced, with back-off when the node says "slow down".
let id = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let i = 0; i < 6; i++) {
    await sleep(PACE_MS);
    try {
      const res = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      if (res.status === 403 || res.status === 429) { await sleep(10_000 * (i + 1)); continue; }
      return await res.json();
    } catch (e) { await sleep(2_000); if (i === 5) return { error: { message: 'network ' + (e as Error).message } }; }
  }
  return { error: { message: 'gave up after repeated 403/429' } };
}

// A real competitor trade from run 37792273152 (Uniswap V3 RDDT/WETH loop).
const TX = '0x7c941db40ebf11b81cfcb5f24010e934bdac6ca534ce54be152cd23b82728bcd';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'; // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)

(async () => {
  const out: string[] = [];
  const show = (label: string, r: any) => {
    const ok = r && !r.error && r.result !== undefined && r.result !== null;
    out.push(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(ok ? r.result : r?.error ?? r).slice(0, 220)}`);
    return ok;
  };
  const latest = Number((await rpc('eth_blockNumber', [])).result);
  out.push(`latest block ${latest}`);
  const tx = (await rpc('eth_getTransactionByHash', [TX])).result;
  const blk = Number(tx?.blockNumber ?? 0);
  out.push(`test tx block ${blk} (${latest - blk} blocks ago), from ${tx?.from} to ${tx?.to}`);
  const parent = '0x' + (blk - 1).toString(16), at = '0x' + blk.toString(16);

  show('eth_getBlockReceipts(tx block) count', await rpc('eth_getBlockReceipts', [at]).then((r) => (r.result ? { result: r.result.length } : r)));
  show('eth_getBalance(from, block-1)', await rpc('eth_getBalance', [tx.from, parent]));
  show('eth_getBalance(from, block)', await rpc('eth_getBalance', [tx.from, at]));
  show('eth_getTransactionCount(from, block-1)', await rpc('eth_getTransactionCount', [tx.from, parent]));
  show('eth_call historical block-1 (WETH.totalSupply)', await rpc('eth_call', [{ to: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', data: '0x18160ddd' }, parent]));
  show('eth_call historical + state override', await rpc('eth_call', [{ to: '0x00000000000000000000000000000000a7b51e00', data: '0x' }, parent, { '0x00000000000000000000000000000000a7b51e00': { code: '0x60016000526020601ff3' } }]));
  show('debug_traceTransaction callTracer', await rpc('debug_traceTransaction', [TX, { tracer: 'callTracer', tracerConfig: { onlyTopCall: false, withLog: false } }]).then((r) => (r.result ? { result: { type: r.result.type, value: r.result.value, calls: (r.result.calls ?? []).length } } : r)));
  show('debug_traceTransaction prestateTracer diffMode', await rpc('debug_traceTransaction', [TX, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]).then((r) => (r.result ? { result: Object.keys(r.result.post ?? {}).length + ' accounts changed' } : r)));
  show('debug_traceBlockByNumber callTracer', await rpc('debug_traceBlockByNumber', [at, { tracer: 'callTracer' }]).then((r) => (r.result ? { result: r.result.length + ' traces' } : r)));
  show('trace_transaction (parity)', await rpc('trace_transaction', [TX]).then((r) => (r.result ? { result: r.result.length + ' frames' } : r)));
  show('trace_replayTransaction stateDiff', await rpc('trace_replayTransaction', [TX, ['stateDiff']]).then((r) => (r.result ? { result: 'ok' } : r)));
  show('eth_simulateV1 at block-1 (empty call)', await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ from: tx.from, to: tx.to, data: '0x' }] }], validation: false }, parent]).then((r) => (r.result ? { result: r.result[0]?.calls?.[0]?.status } : r)));
  show('eth_getLogs 10k-block range on PoolManager', await rpc('eth_getLogs', [{ address: POOL_MANAGER, fromBlock: '0x' + (blk - 10_000).toString(16), toBlock: at, topics: [INIT_TOPIC] }]).then((r) => (r.result ? { result: r.result.length + ' logs' } : r)));
  show('eth_getLogs from block 0 Initialize', await rpc('eth_getLogs', [{ address: POOL_MANAGER, fromBlock: '0x0', toBlock: 'latest', topics: [INIT_TOPIC] }]).then((r) => (r.result ? { result: r.result.length + ' logs' } : r)));
  // How far back does the node keep state? Try a few ages.
  for (const age of [100_000, 1_000_000, 5_000_000]) {
    const b = '0x' + Math.max(1, latest - age).toString(16);
    show(`eth_getBalance ${age} blocks back`, await rpc('eth_getBalance', [tx.from, b]));
  }
  const text = out.join('\n');
  console.log(text);
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
  console.log(`::notice title=Node capabilities::${esc(text)}`);
  // Annotation size test: long messages; the tail marker shows if they were cut.
  for (const n of [4_000, 16_000, 60_000]) {
    console.log(`::notice title=Size test ${n}::${esc('x'.repeat(n - 20) + `\nEND-MARKER-${n}`)}`);
  }
})();
