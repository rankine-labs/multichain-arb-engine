import { makeFallbackRpc, Rpc } from '../execution/simulator';

// Simulations fall back to the public node when the paid node refuses, and
// real answers (like revert data) are never treated as "refused".

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  let t = 0, mode: 'ok' | 'limited' | 'revert' = 'ok';
  const calls: string[] = [];
  const paid: Rpc = async () => { calls.push('paid');
    if (mode === 'limited') return { error: { code: 429, message: 'rate limited (HTTP 429)' } };
    if (mode === 'revert') return { error: { code: 3, message: 'execution reverted', data: '0x1234' } };
    return { result: '0xpaid' }; };
  const pub: Rpc = async () => { calls.push('public'); return { result: '0xpublic' }; };
  const logs: string[] = [];
  const rpc = makeFallbackRpc(paid, pub, (m) => logs.push(m), 300_000, () => t);
  assert((await rpc('eth_call', [])).result === '0xpaid', 'paid node used while healthy');
  mode = 'revert';
  assert((await rpc('eth_call', [])).error?.data === '0x1234' && !calls.includes('public'), 'revert data is a real answer, no fallback');
  mode = 'limited';
  assert((await rpc('eth_call', [])).result === '0xpublic' && logs.length === 1, 'rate limited -> public node answers');
  calls.length = 0;
  await rpc('eth_call', []);
  assert(calls.join() === 'public', 'paid node rested for a while');
  mode = 'ok'; t = 300_001; calls.length = 0;
  assert((await rpc('eth_call', [])).result === '0xpaid' && calls.join() === 'paid', 'paid node tried again after the rest');
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
