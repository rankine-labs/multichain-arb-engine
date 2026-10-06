import { NodeBudget, BudgetExceeded, callsInBody } from '../core/nodeBudget';
import { findBalanceSlot, Rpc } from '../execution/simulator';
import { ethers } from 'ethers';

// Speed limit + daily allowance per node, and the one-request balance lookup.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  // --- daily allowance -----------------------------------------------------
  const b = new NodeBudget('quicknode', 1000, 5);
  for (let i = 0; i < 5; i++) await b.take();
  let threw = false;
  try { await b.take(); } catch (e) { threw = e instanceof BudgetExceeded && /429/.test((e as Error).message); }
  assert(threw, 'over the daily allowance -> refused with a 429-style error');
  assert(b.share() === 1, 'usage share tracked');

  // --- speed limit: requests wait instead of bursting ----------------------
  const s = new NodeBudget('public', 10, Infinity);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 20 }, () => s.take()));
  const took = Date.now() - t0;
  assert(took >= 900, `20 requests at 10/s are spread out (took ${took} ms, not a burst)`);

  // --- queue too long: fail fast instead of waiting forever -----------------
  const q = new NodeBudget('nodeflare', 1, Infinity, Date.now, 2_000);
  let qThrew = false;
  try { await Promise.all(Array.from({ length: 10 }, () => q.take())); } catch { qThrew = true; }
  assert(qThrew, 'very long queue -> fails fast');

  assert(callsInBody(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }])) === 3 && callsInBody('{"id":1}') === 1, 'batched JSON-RPC counts each call');

  // --- one-request balance lookup -------------------------------------------
  // Fake token: balances live in a Solidity mapping at slot 7.
  const abi = ethers.AbiCoder.defaultAbiCoder();
  let calls = 0;
  const rpc: Rpc = async (_m, params: any[]) => {
    calls++;
    const holder = '0x' + params[0].data.slice(-40);
    const key = ethers.keccak256(abi.encode(['address', 'uint256'], [holder, 7]));
    const diff = params[2][params[0].to].stateDiff as Record<string, string>;
    const v = diff[key] ?? '0x0';
    return { result: ethers.zeroPadValue(v, 32) };
  };
  const found = await findBalanceSlot(rpc, 'test:token', '0x' + '77'.repeat(20));
  assert(!!found && 'key' in found, 'balance location found');
  assert(calls === 2, `found in 2 requests (was up to 122): ${calls}`);
  const again = await findBalanceSlot(rpc, 'test:token', '0x' + '77'.repeat(20));
  assert(again === found && calls === 2, 'second lookup is free (cached)');

  // Token that ALSO reads a per-account "frozen" flag at slot 3: if that key
  // is overridden too, balanceOf returns 0 (hides the answer).
  let calls2 = 0;
  const rpc2: Rpc = async (_m, params: any[]) => {
    calls2++;
    const holder = '0x' + params[0].data.slice(-40);
    const balKey = ethers.keccak256(abi.encode(['address', 'uint256'], [holder, 7]));
    const frozenKey = ethers.keccak256(abi.encode(['address', 'uint256'], [holder, 3]));
    const diff = params[2][params[0].to].stateDiff as Record<string, string>;
    if (diff[frozenKey]) return { result: ethers.zeroPadValue('0x00', 32) };
    return { result: ethers.zeroPadValue(diff[balKey] ?? '0x00', 32) };
  };
  const f2 = await findBalanceSlot(rpc2, 'test:frozen', '0x' + '88'.repeat(20));
  assert(!!f2 && 'key' in f2 && calls2 <= 20, `token with a frozen flag: found one at a time (${calls2} requests, one-time)`);
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
