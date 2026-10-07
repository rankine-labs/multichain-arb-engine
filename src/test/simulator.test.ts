import { simRpcUrl, wssToHttps, isRateLimited, simulateRoundTrip, Rpc, replayRpc, SIM_EXECUTOR_ADDRESS } from '../execution/simulator';

// Checks which RPC simulations use, and that "slow down" responses are
// reported as rate limits rather than as failed trades.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  // 1. Endpoint selection.
  assert(simRpcUrl('monad', {}).source === 'public endpoint' && simRpcUrl('monad', {}).url === 'https://rpc.monad.xyz', 'no config -> public endpoint');
  const qn = simRpcUrl('monad', { MONAD_QUICKNODE_WSS: 'wss://abc.monad-mainnet.quiknode.pro/KEY/' });
  assert(qn.source === 'your paid endpoint (QuickNode)' && qn.url === 'https://abc.monad-mainnet.quiknode.pro/KEY/', 'QuickNode websocket -> same URL over HTTPS');
  const fake = simRpcUrl('avalanche', { AVALANCHE_ALCHEMY_WSS: 'wss://api.avax.network/ext/bc/C/ws' });
  assert(fake.source.startsWith('free public node'), 'a "paid" setting that holds the public URL is labelled as the public node');
  const avax = simRpcUrl('avalanche', { AVALANCHE_QUICKNODE_WSS: 'wss://x.avalanche-mainnet.quiknode.pro/KEY/ext/bc/C/ws' });
  assert(avax.url === 'https://x.avalanche-mainnet.quiknode.pro/KEY/ext/bc/C/rpc', 'Avalanche /ext/bc/C/ws -> /ext/bc/C/rpc');
  assert(simRpcUrl('avalanche', { AVALANCHE_QUICKNODE_WSS: 'wss://REPLACE_WITH_QUICKNODE_AVAX_ENDPOINT' }).source === 'public endpoint', 'placeholder URL ignored');
  assert(simRpcUrl('robinhood', { SIM_RPC_ROBINHOOD: 'https://mine', ROBINHOOD_RPC_HTTP: 'https://other' }).url === 'https://mine', 'explicit SIM_RPC wins');
  assert(simRpcUrl('robinhood', { ROBINHOOD_RPC_HTTP: 'https://other' }).url === 'https://other', 'Robinhood uses ROBINHOOD_RPC_HTTP if set');
  assert(wssToHttps('https://not-a-websocket') === null, 'non-websocket URL not converted');

  // 2. Rate-limit detection.
  assert(isRateLimited({ code: 429 }) && isRateLimited({ message: 'daily request limit exceeded' }) && isRateLimited({ code: -32005 }), 'rate limits recognised');
  assert(!isRateLimited({ code: 3, message: 'execution reverted' }), 'a revert is not a rate limit');

  // 3. A rate-limited RPC yields 'rate_limited', not 'fail' or a cached "no slot".
  let calls = 0;
  const limited: Rpc = async () => { calls++; return { error: { code: 429, message: 'rate limited (HTTP 429)' } }; };
  const trade = { token: '0x0000000000000000000000000000000000000001', amountIn: 1n, hops: [] };
  const r1 = await simulateRoundTrip(limited, 'test', trade);
  assert(r1.status === 'rate_limited', `rate-limited RPC -> rate_limited (got ${r1.status})`);
  assert(calls === 1, 'stops probing immediately when rate limited');
  // Once the RPC recovers, the token is probed again (nothing wrong was cached).
  const recovered: Rpc = async () => ({ error: { code: -32602, message: 'too many arguments' } });
  const r2 = await simulateRoundTrip(recovered, 'test', trade);
  assert(r2.status === 'unsupported', `after recovery the token is re-probed (got ${r2.status})`);

  // 4. Network errors (RPC down) are treated as temporary, not as failed trades.
  const down: Rpc = async () => ({ error: { message: 'network: fetch failed' } });
  const slotOk: Rpc = async (method, params) => {
    // Pretend the balance slot is found on the first probe, then the sim call hits a network error.
    const p = params as any[];
    if (p[0]?.data?.startsWith('0x70a08231')) {
      const diff = Object.values(p[2])[0] as any;
      return { result: Object.values(diff.stateDiff)[0] };
    }
    return down(method, params);
  };
  const r3 = await simulateRoundTrip(slotOk, 'test2', trade);
  assert(r3.status === 'rate_limited', `network error during simulation -> paused, not a failed trade (got ${r3.status})`);

  // 5. The trigger check can test against a chosen block (right after the
  //    trade we follow) instead of 'latest'.
  let simBlock: unknown = null;
  const blockSpy: Rpc = async (method, params) => {
    const p = params as any[];
    if (p[0]?.data?.startsWith('0x70a08231')) {
      const diff = Object.values(p[2])[0] as any;
      return { result: Object.values(diff.stateDiff)[0] };
    }
    simBlock = p[1];
    return { error: { message: 'execution reverted' } };
  };
  await simulateRoundTrip(blockSpy, 'test3', trade, { blockTag: '0x1a2b' });
  assert(simBlock === '0x1a2b', `simulation runs on the requested block (got ${String(simBlock)})`);
  await simulateRoundTrip(blockSpy, 'test3', trade);
  assert(simBlock === 'latest', 'no block given -> latest');

  // 6. Replay: our sim call becomes eth_simulateV1 [trigger, ours] on the
  //    parent block; the profit-guard revert comes back like an eth_call's.
  let sent: any = null;
  const insufficient = '0x' + 'f1f24d3a'.padEnd(8, '0'); // any 4 bytes: parsed below only as revert data
  const node: Rpc = async (method, params) => {
    const p = params as any[];
    if (method === 'eth_call') { const diff = Object.values(p[2])[0] as any; return { result: Object.values(diff.stateDiff)[0] }; }
    sent = { method, params };
    return { result: [{ calls: [{ status: '0x1', returnData: '0x' }, { status: '0x0', returnData: insufficient, error: { message: 'execution reverted' } }] }] };
  };
  const trigger = { from: '0x00000000000000000000000000000000000000aa', to: '0x00000000000000000000000000000000000000bb', data: '0x1234' };
  const rr = replayRpc(node, '0x10', [trigger]);
  const out = await rr('eth_call', [{ to: SIM_EXECUTOR_ADDRESS, data: '0x' }, 'latest', { x: 1 }]);
  assert(sent?.method === 'eth_simulateV1' && sent.params[1] === '0x10', 'replay runs on the parent block');
  assert(sent.params[0].blockStateCalls[0].calls[0].data === '0x1234' && sent.params[0].blockStateCalls[0].calls.length === 2, 'trigger replayed first, then our trade');
  assert(sent.params[0].blockStateCalls[0].stateOverrides.x === 1 && sent.params[0].validation === false, 'our pretend-state goes along, validation off');
  assert(BigInt(sent.params[0].blockStateCalls[0].blockOverrides.gasLimit) >= 1_000_000_000n, 'simulated block has room for replayed trades plus ours');
  const rt = replayRpc(node, '0x10', [trigger], '0x6543');
  await rt('eth_call', [{ to: SIM_EXECUTOR_ADDRESS, data: '0x' }, 'latest', {}]);
  assert(sent.params[0].blockStateCalls[0].blockOverrides.time === '0x6543', 'simulated block uses the real block time');
  assert(out.error?.data === insufficient, 'our revert data comes back like an eth_call error');
  // Real node shape: returnData "0x", revert data in error.data.
  const realShape: Rpc = async () => ({ result: [{ calls: [{ status: '0x1', returnData: '0x' }, { status: '0x0', returnData: '0x', error: { message: 'execution reverted', code: 3, data: insufficient } }] }] });
  const out2 = await replayRpc(realShape, '0x10', [trigger])('eth_call', [{ to: SIM_EXECUTOR_ADDRESS, data: '0x' }, 'latest', {}]);
  assert(out2.error?.data === insufficient, 'revert data read from error.data when returnData is empty (real node answer)');
  const other = await rr('eth_call', [{ to: '0x00000000000000000000000000000000000000cc', data: '0x70a08231' }, 'latest', { ['0x00000000000000000000000000000000000000cc']: { stateDiff: { k: '0x05' } } }]);
  assert(other.result === '0x05', 'other calls (balance slot lookups) pass straight through');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
