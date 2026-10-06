import { FailoverRouter } from '../core/failoverRpc';

// Slow counts as sick (rest the node, use the others or the paid node), and
// several free nodes share the load in turn.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  let clock = 0;
  const calls: string[] = [];
  const node = (label: string, ms: number) => ({
    label,
    send: async (p: any) => { calls.push(label); clock += ms; return [{ id: p.id, jsonrpc: '2.0', result: label }] as any; },
  });
  const logs: string[] = [];
  const payload = { id: 1, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] } as any;

  // One slow free node (900 ms) + paid node.
  const r1 = new FailoverRouter(node('public', 900), node('alchemy', 20), { now: () => clock, log: (l) => logs.push(l), slowMs: 300 });
  for (let i = 0; i < 10; i++) await r1.send(payload);
  assert(logs.some((l) => /fast path -> alchemy.*slow/.test(l)), 'a node averaging 900 ms is rested as slow');
  calls.length = 0;
  await r1.send(payload);
  assert(calls[0] === 'alchemy', 'while rested, reads go to the paid node');
  clock += 5 * 60_000 + 1;
  calls.length = 0;
  await r1.send(payload);
  assert(calls[0] === 'public', 'after 5 min the free node is tried again');

  // Two free nodes rotate; when one is slow the other carries on.
  clock = 0; calls.length = 0; logs.length = 0;
  const r2 = new FailoverRouter([node('public', 900), node('second', 30)], node('alchemy', 20), { now: () => clock, log: (l) => logs.push(l), slowMs: 300 });
  for (let i = 0; i < 4; i++) await r2.send(payload);
  assert(calls.includes('public') && calls.includes('second'), 'reads rotate across both free nodes');
  for (let i = 0; i < 30; i++) await r2.send(payload);
  assert(logs.some((l) => /public rested.*reads on second/.test(l)), 'slow node rested on its own, the other keeps serving');
  calls.length = 0;
  for (let i = 0; i < 5; i++) await r2.send(payload);
  assert(calls.every((c) => c === 'second'), 'paid node not needed while one free node is healthy');
  assert(!logs.some((l) => /https?:\/\//.test(l)), 'no URLs in log lines');
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
