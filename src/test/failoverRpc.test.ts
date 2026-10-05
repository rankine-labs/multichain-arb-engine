import { FailoverRouter, isEndpointTrouble, shortReason, RpcSend } from '../core/failoverRpc';

// Checks the fast/heavy split: normal reads go to FAST; a rate limit, timeout
// or network failure on FAST retries on HEAVY and rests FAST for 5 min; after
// that FAST is used again; errors about the call itself never switch; with no
// paid node everything stays on FAST; one log line per switch.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

type Mode = 'ok' | 'http429' | 'json429' | 'timeout' | 'revert' | 'network';
function fakeNode(name: string) {
  const node = { calls: 0, mode: 'ok' as Mode, send: (async () => []) as RpcSend };
  node.send = async (payload) => {
    node.calls++;
    const list = Array.isArray(payload) ? payload : [payload];
    if (node.mode === 'http429') { const e: any = new Error('server response 429 Too Many Requests'); e.code = 'SERVER_ERROR'; throw e; }
    if (node.mode === 'timeout') { const e: any = new Error('request timeout'); e.code = 'TIMEOUT'; throw e; }
    if (node.mode === 'network') throw new TypeError('fetch failed: ECONNRESET');
    if (node.mode === 'json429') return list.map((p) => ({ id: p.id, error: { code: -32005, message: 'rate limit exceeded' } }));
    if (node.mode === 'revert') return list.map((p) => ({ id: p.id, error: { code: 3, message: 'execution reverted' } }));
    return list.map((p) => ({ id: p.id, result: name }));
  };
  return node;
}
const req = (id = 1) => ({ jsonrpc: '2.0' as const, id, method: 'eth_blockNumber', params: [] });
const resultOf = (r: any[]) => r[0]?.result;

async function main() {
  let clock = 1_000_000;
  const logs: string[] = [];
  const fast = fakeNode('fast'), heavy = fakeNode('heavy');
  const router = new FailoverRouter({ label: 'Robinhood node', send: fast.send }, { label: 'Alchemy', send: heavy.send },
    { now: () => clock, log: (l) => logs.push(l) });

  // Normal: FAST answers.
  assert(resultOf(await router.send(req())) === 'fast' && heavy.calls === 0, 'normal reads go to the fast node');

  // HTTP 429 on FAST: same request answered by HEAVY, FAST rested.
  fast.mode = 'http429';
  assert(resultOf(await router.send(req())) === 'heavy', 'HTTP 429 on fast node -> request answered by paid node');
  assert(!router.getStats().onFast && router.getStats().switches === 1, 'fast node rested after a rate limit');
  assert(logs.length === 1 && logs[0].includes('Alchemy for 5 min'), 'one log line on the switch');

  // While resting, FAST isn't touched at all, and no more log lines.
  fast.mode = 'ok';
  const fastBefore = fast.calls;
  for (let i = 0; i < 20; i++) { clock += 10_000; await router.send(req()); } // 200 s later
  assert(fast.calls === fastBefore, 'fast node not asked while resting');
  assert(logs.length === 1, 'no log spam while resting');

  // After 5 minutes: back on FAST, one log line.
  clock += 120_000;
  assert(resultOf(await router.send(req())) === 'fast', 'after 5 min, reads go back to the fast node');
  assert(logs.length === 2 && logs[1].includes('back on Robinhood node'), 'one log line on the switch back');

  // Rate limit reported inside the JSON-RPC reply (HTTP 200) also counts.
  fast.mode = 'json429';
  assert(resultOf(await router.send([req(1), req(2)])) === 'heavy', 'rate limit inside the reply -> whole batch resent to paid node');
  assert(router.getStats().switches === 2, 'second switch counted');

  // Timeouts and network failures switch too.
  for (const mode of ['timeout', 'network'] as Mode[]) {
    clock += 6 * 60_000; fast.mode = 'ok'; await router.send(req()); // recover
    fast.mode = mode;
    assert(resultOf(await router.send(req())) === 'heavy', `${mode} on fast node -> answered by paid node`);
  }

  // A reverted call is a real answer: no switch.
  clock += 6 * 60_000; fast.mode = 'ok'; await router.send(req());
  const switches = router.getStats().switches;
  fast.mode = 'revert';
  const r = await router.send(req());
  assert((r[0] as any).error?.message === 'execution reverted' && router.getStats().switches === switches, 'reverted call returned as-is, no switch');

  // A thrown error that isn't endpoint trouble is passed on, no switch.
  const odd = new FailoverRouter({ label: 'f', send: async () => { throw new Error('invalid argument'); } }, { label: 'h', send: heavy.send }, { now: () => clock, log: () => {} });
  let threw = false;
  try { await odd.send(req()); } catch { threw = true; }
  assert(threw && odd.getStats().switches === 0, 'non-endpoint errors are passed on, no switch');

  // No paid node: everything on FAST, errors passed on, nothing to switch to.
  const solo = fakeNode('solo');
  const only = new FailoverRouter({ label: 'public', send: solo.send }, null, { now: () => clock, log: (l) => logs.push(l) });
  solo.mode = 'json429';
  const out = await only.send(req());
  assert((out[0] as any).error?.code === -32005 && only.getStats().onFast, 'no paid node: rate-limit reply passed back, stays on fast node');

  // Error classification.
  assert(isEndpointTrouble({ code: 'TIMEOUT', message: 'x' }), 'TIMEOUT is endpoint trouble');
  assert(isEndpointTrouble(new Error('socket hang up')), 'socket hang up is endpoint trouble');
  assert(!isEndpointTrouble(new Error('execution reverted')), 'execution reverted is not endpoint trouble');

  // Log reasons are short and never contain a URL (keys live in URLs).
  const leaky = new Error('exceeded maximum retry limit (info={ "requestUrl": "https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123" })');
  assert(shortReason(leaky) === 'rate limited' && !shortReason(leaky).includes('SECRET'), 'log reason is short and hides URLs/keys');
  assert(logs.every((l) => !l.includes('http')), 'no URLs in any switch log line');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
