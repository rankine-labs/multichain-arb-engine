// ============================================================================
// SIMULATE-V1 PROBE -- can the Robinhood node replay "trigger trade, then ours"?
//
// Plain English:
//   To know if a backrun would have made money, we need the market state
//   RIGHT AFTER the trigger trade, before anyone else trades. A plain
//   eth_call can only use the state at the END of a block (after rivals).
//   eth_simulateV1 can run several calls in order on a past block, so we can
//   replay the trigger and then test our trade. This checks the node
//   supports it: (1) a simple call, (2) replaying a real past transaction.
//   Read-only, no keys.
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-simv1.js
// ============================================================================
const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

let id = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const j = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    if (j.error && /429|Too Many/i.test(JSON.stringify(j.error))) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    return j;
  }
  return { error: { message: 'rate limited 4x' } };
}

(async () => {
  // 1) Simple call: WETH.balanceOf(WETH) on latest.
  const simple = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ to: WETH, data: '0x70a08231' + WETH.slice(2).toLowerCase().padStart(64, '0') }] }] }, 'latest']);
  console.log('simple call:', simple.error ? `ERROR ${JSON.stringify(simple.error).slice(0, 200)}` : `OK status=${simple.result?.[0]?.calls?.[0]?.status}`);
  if (simple.error) { console.log('RESULT: eth_simulateV1 NOT supported on this node'); return; }

  // 2) Replay a real user transaction from a recent block on its parent block.
  const latest = Number((await rpc('eth_blockNumber', [])).result);
  for (let n = latest - 5; n > latest - 200; n--) {
    const b = (await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), true])).result;
    const tx = b?.transactions?.find((t: any) => t.type !== '0x6a' && t.to && t.input && t.input.length > 10);
    if (!tx) continue;
    const call = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas };
    const r = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [call, { to: WETH, data: '0x18160ddd' }] }], validation: false }, '0x' + (n - 1).toString(16)]);
    if (r.error) { console.log(`replay of ${tx.hash} on block ${n - 1}: ERROR ${JSON.stringify(r.error).slice(0, 200)}`); console.log('RESULT: simple calls work, replay failed'); return; }
    const c = r.result?.[0]?.calls ?? [];
    console.log(`replay of ${tx.hash} on block ${n - 1}: trigger status=${c[0]?.status} gasUsed=${c[0]?.gasUsed}, follow-up call status=${c[1]?.status}`);
    console.log('RESULT: eth_simulateV1 works, can replay trigger then our trade');
    return;
  }
  console.log('RESULT: simple calls work, no recent tx found to replay');
})();
