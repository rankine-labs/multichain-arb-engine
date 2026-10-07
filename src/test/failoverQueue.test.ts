import { FailoverRouter } from '../core/failoverRpc';

// Oct 7 fixes: (1) time spent waiting in our own speed-limit queue must not
// make a fast node look "slow" (it got rested, and reads moved to the
// backup until its allowance ran out); (2) when the backup fails and the
// main node is resting, ask the main node instead of failing the read.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  let clock = 0;
  const logs: string[] = [];
  const answer = (label: string, ms: number) => async (p: any) => { clock += ms; return [{ id: p.id, jsonrpc: '2.0', result: label }] as any; };
  const payload = { id: 1, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] } as any;

  // (1) Node answers in 20 ms but every request waits 900 ms in our queue.
  const r = new FailoverRouter(
    { label: 'public', send: answer('public', 20), wait: async () => { clock += 900; } },
    null,
    { now: () => clock, log: (l) => logs.push(l), slowMs: 300, backups: [{ label: 'nodeflare (backup)', send: answer('nodeflare', 20) }] },
  );
  for (let i = 0; i < 20; i++) await r.send(payload);
  assert(!logs.some((l) => /rested/.test(l)), 'queue wait is not counted: a 20 ms node is never rested as slow');

  // (2) Main resting, backup's daily allowance used up, no paid node.
  logs.length = 0;
  let mainCalls = 0;
  const r2 = new FailoverRouter(
    { label: 'public', send: async (p: any) => { mainCalls++; return [{ id: p.id, jsonrpc: '2.0', result: 'public' }] as any; } },
    null,
    { now: () => clock, log: (l) => logs.push(l), slowMs: 300, backups: [{ label: 'nodeflare (backup)', send: async () => { throw new Error('nodeflare daily allowance used up (429)'); } }] },
  );
  (r2 as any).fasts[0].restUntil = clock + 60_000; // main resting
  const out = await r2.send(payload);
  assert((out[0] as any).result === 'public' && mainCalls === 1, 'backup out of allowance -> read answered by the resting main node, not failed');

  // (3) Main comes back after its rest: one "back on" line for the status page.
  logs.length = 0;
  const r3 = new FailoverRouter(
    { label: 'public', send: answer('public', 20) }, null,
    { now: () => clock, log: (l) => logs.push(l), backups: [{ label: 'nodeflare (backup)', send: answer('nodeflare', 20) }] },
  );
  (r3 as any).fasts[0].restUntil = clock + 1_000;
  const b = await r3.send(payload);
  clock += 2_000;
  const m = await r3.send(payload);
  await r3.send(payload);
  assert((b[0] as any).result === 'nodeflare' && (m[0] as any).result === 'public', 'backup while main rests, main again after');
  assert(logs.filter((l) => /fast path back on public/.test(l)).length === 1, 'one "back on" line when the main node returns');
}
main();
