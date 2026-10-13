// ============================================================================
// "FAILED WITH NO REASON" / "BUILT THE TRADE WRONG" -- Oct 12 fixes
//
// Plain English:
//   The hourly report showed most practice checks as "failed with no reason
//   given" and a few as "our bot built the trade wrong". This test checks:
//     1. every error our contract can give (read straight from
//        contracts/src/ArbExecutor.sol) is decoded into words and lands in a
//        real group, never in "no reason" or "other"
//     2. "pool gave back / took nothing" no longer counts as our bug
//     3. every eth_simulateV1 (replay) answer shape is read correctly, and a
//        replay whose answers don't line up falls back to a plain check
//        instead of being misread as "our call succeeded" (= built wrong)
//     4. unknown revert data keeps its first 10 bytes, and a few raw examples
//        an hour go to the log
//     5. a "no reason" failure gets a second opinion from the backup node
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import {
  simulateRoundTrip, simulateWithRecheck, isNoReasonFail, readReplayAnswer, replayRpc, setSimDiagnosticLog, Rpc,
} from '../execution/simulator';
import { classifyFailReason, classifySimOutcome, normaliseRawReason, SampleLimiter, FailGroup } from '../core/failReasons';
import { ARB_EXECUTOR_RUNTIME_CODE } from '../execution/arbExecutorBytecode';
import { KIND_V2, KIND_V3 } from '../execution/executorCalldata';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const TOKEN = '0x' + '11'.repeat(20), MID = '0x' + '22'.repeat(20), LENDER = '0x' + '33'.repeat(20);
const trade = {
  token: TOKEN, amountIn: 10n ** 18n,
  hops: [
    { kind: KIND_V3, pool: '0x' + '44'.repeat(20), tokenIn: TOKEN, tokenOut: MID, feeBps: 0 },
    { kind: KIND_V2, pool: '0x' + '55'.repeat(20), tokenIn: MID, tokenOut: TOKEN, feeBps: 30 },
  ],
};
const MAX = (1n << 256n) - 1n;

// A node that finds the balance slot instantly, then answers our check with `answer`.
const nodeAnswering = (answer: { result?: any; error?: any }): Rpc => async (_m, params) => {
  const p = params as any[];
  if (p[0]?.data?.startsWith('0x70a08231')) { const diff = Object.values(p[2])[0] as any; return { result: Object.values(diff.stateDiff)[0] }; }
  return answer;
};

// What each contract error MEANS in a practice check (minProfit is set
// impossibly high, deadline never, our own executor, lender allowed).
const EXPECTED: Record<string, { status: string; group?: FailGroup }> = {
  InsufficientProfit: { status: 'profit-or-loss' },
  TokenBalanceDropped: { status: 'fail', group: 'tax' },
  UnsupportedKind: { status: 'fail', group: 'ours' },
  BadRoute: { status: 'fail', group: 'ours' },
  ZeroAmount: { status: 'fail', group: 'stale' },          // a pool paid out nothing
  Expired: { status: 'fail', group: 'ours' },
  UnauthorizedCallback: { status: 'fail', group: 'stale' }, // a V3 pool asked for nothing
  TransferFailed: { status: 'fail', group: 'transfer' },    // own money (flash: loss, below)
  NotExecutor: { status: 'fail', group: 'ours' },
  NotOwner: { status: 'fail', group: 'ours' },
  NotPendingOwner: { status: 'fail', group: 'ours' },
  OwnerIsExecutor: { status: 'fail', group: 'ours' },
  FlashPoolNotAllowed: { status: 'fail', group: 'ours' },
  V4NotEnabled: { status: 'fail', group: 'ours' },
  UnexpectedEth: { status: 'fail', group: 'ours' },
  Reentrancy: { status: 'fail', group: 'ours' },
};

async function main() {
  const logged: string[] = [];
  setSimDiagnosticLog((m) => logged.push(m));

  // ---- 1. Every contract error, straight from the Solidity source ----------
  const src = readFileSync(join(__dirname, '..', '..', 'contracts', 'src', 'ArbExecutor.sol'), 'utf8');
  const errors = [...src.matchAll(/^\s*error (\w+)\(([^)]*)\);/gm)].map((m) => ({
    name: m[1],
    sig: `error ${m[1]}(${m[2]})`,
  }));
  assert(errors.length >= 16, `found the contract's errors in the source (${errors.length})`);
  const iface = new ethers.Interface(errors.map((e) => e.sig));
  let n = 0;
  for (const e of errors) {
    const frag = iface.getError(e.name)!;
    // Selector really is in the bytecode the checker runs (bytecode up to date).
    assert(ARB_EXECUTOR_RUNTIME_CODE.includes(frag.selector.slice(2)), `${e.name}: error code ${frag.selector} is in the simulated contract`);
    const args = frag.inputs.map((i) => (i.type === 'address' ? MID : i.type === 'uint256' && e.name === 'InsufficientProfit' ? (i.name === 'got' ? 5n : MAX) : 1n));
    const data = iface.encodeErrorResult(e.name, args);
    const r = await simulateRoundTrip(nodeAnswering({ error: { code: 3, message: 'execution reverted', data } }), `c${n++}`, trade);
    const want = EXPECTED[e.name];
    assert(!!want, `${e.name}: has an expected meaning in this test (new contract error? add it here and to simulator.ts)`);
    if (!want) continue;
    if (want.status === 'profit-or-loss') { assert(r.status === 'profit', `${e.name}(got>0) -> profit`); continue; }
    const reason = 'reason' in r ? r.reason : '';
    assert(r.status === 'fail' && !reason.startsWith('revert 0x'), `${e.name}: decoded into words ("${reason}")`);
    assert(classifyFailReason(reason) === want.group, `${e.name}: lands in "${want.group}" (got "${classifyFailReason(reason)}")`);
    assert(classifySimOutcome(r.status, reason) !== 'missing_revert_data', `${e.name}: never counted as "no reason given"`);
  }
  const loss = await simulateRoundTrip(nodeAnswering({ error: { code: 3, message: 'execution reverted', data: iface.encodeErrorResult('InsufficientProfit', [0n, MAX]) } }), 'loss', trade);
  assert(loss.status === 'loss' && loss.bucket === 'real_loss', 'InsufficientProfit(0) -> would lose money');
  const flashLoss = await simulateRoundTrip(nodeAnswering({ error: { code: 3, message: 'execution reverted', data: iface.encodeErrorResult('TransferFailed', []) } }), 'fl', trade, { v3Lender: LENDER });
  assert(flashLoss.status === 'loss', 'flash loan: TransferFailed (loan not repaid) -> would lose money');

  // ---- 2. Reasons from other contracts in the route --------------------------
  const ext = new ethers.Interface([
    'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
    'error ERC20TransferFailed()', 'error insufficientInputAmount()', 'error invalidLimitSqrtPrice()',
    'error CurrencyNotSettled()', 'error Panic(uint256)',
  ]);
  const extCase = async (data: string) => {
    const r = await simulateRoundTrip(nodeAnswering({ error: { code: 3, message: 'execution reverted', data } }), `e${n++}`, trade);
    return 'reason' in r ? r.reason : r.status;
  };
  const wrapped = await extCase(ext.encodeErrorResult('WrappedError', [MID, '0x12345678', ext.encodeErrorResult('ERC20TransferFailed', []), '0x']));
  assert(/ERC20TransferFailed/.test(wrapped) && classifyFailReason(wrapped) === 'transfer', `V4 WrappedError shows the coin's own error ("${wrapped}")`);
  assert(classifyFailReason(await extCase(ext.encodeErrorResult('insufficientInputAmount', []))) === 'tax', 'Algebra insufficientInputAmount = pool got fewer coins (like V3 IIA)');
  assert(classifyFailReason(await extCase(ext.encodeErrorResult('invalidLimitSqrtPrice', []))) === 'stale', 'Algebra price at the end of its range = old pool info');
  assert(classifyFailReason(await extCase(ext.encodeErrorResult('CurrencyNotSettled', []))) === 'ours', 'V4 CurrencyNotSettled = our bug');
  const pan = await extCase(ext.encodeErrorResult('Panic', [0x11n]));
  assert(/over\/underflow/.test(pan), `Panic code explained in words ("${pan}")`);
  assert(classifyFailReason('SPL') === 'stale', 'SPL (pool price at the end of its range) = old pool info, not our bug');
  assert(classifyFailReason('LOK') === 'ours', 'LOK (pool locked: we re-entered it) is still our bug');
  assert(classifyFailReason('node said: request expired') !== 'ours', 'the word "expired" in a node message is not our Expired() error');

  // ---- 3. Unknown revert data: first 10 bytes kept + logged ------------------
  logged.length = 0;
  const unknownData = '0xabcdef01' + '00'.repeat(31) + '07';
  const u = await simulateRoundTrip(nodeAnswering({ error: { code: 3, message: 'execution reverted', data: unknownData } }), 'unk', trade);
  assert('reason' in u && u.reason === 'revert ' + unknownData.slice(0, 22), `unknown revert keeps its first 10 bytes ("${'reason' in u ? u.reason : ''}")`);
  assert(normaliseRawReason('revert ' + unknownData.slice(0, 22)) === 'revert ' + unknownData.slice(0, 22), 'hourly raw-reason count keeps those 10 bytes');
  assert(normaliseRawReason('TokenBalanceDropped(0x' + 'ab'.repeat(20) + ')') === 'TokenBalanceDropped(0x…)', 'addresses are still collapsed in the raw count');
  assert(logged.some((l) => l.includes('[sim-diag] unknown revert data 0xabcdef01') && l.includes('V3@0x44444444')), 'unknown revert sampled to the log with the route');
  logged.length = 0;
  await simulateRoundTrip(nodeAnswering({ error: { code: -32000, message: 'execution reverted' } }), 'nod', trade);
  assert(logged.some((l) => l.includes('[sim-diag] no revert data') && l.includes('fields=[code,message]') && l.includes('via eth_call')), 'no-data failure sampled with what the node sent');
  const lim = new SampleLimiter(2, () => 1_000);
  assert(lim.take('x') && lim.take('x') && !lim.take('x') && lim.take('y'), 'at most N examples an hour per kind');

  // ---- 4. eth_simulateV1 answer shapes --------------------------------------
  const ok = { status: '0x1', returnData: '0xbeef' };
  const ins = iface.encodeErrorResult('InsufficientProfit', [5n, MAX]);
  assert(readReplayAnswer([{ calls: [ok, { status: '0x0', returnData: '0x', error: { code: 3, message: 'execution reverted', data: ins } }] }], 2).error?.data === ins, 'standard shape: data in error.data');
  assert(readReplayAnswer({ calls: [ok, { status: '0x0', error: { message: 'execution reverted', data: ins } }] }, 2).error?.data === ins, 'single block not in a list');
  assert(readReplayAnswer([{ calls: [ok, { status: 0, returnData: ins }] }], 2).error?.data === ins, 'numeric status, data only in returnData');
  assert(readReplayAnswer([{ calls: [ok, { error: { message: 'execution reverted', data: { data: ins } } }] }], 2).error?.data === ins, 'no status, data one level deeper');
  const strErr = readReplayAnswer([{ calls: [ok, { status: '0x0', error: 'execution reverted' }] }], 2);
  assert(strErr.error?.message === 'execution reverted' && strErr.error?.data === undefined, 'error given as plain text');
  assert(readReplayAnswer([{ calls: [ok, { status: '0x1', returnData: '0x' }] }], 2).result === '0x', 'our call succeeded -> result');
  const short = readReplayAnswer([{ calls: [ok] }], 2);
  assert(/^replay unavailable/.test(short.error?.message ?? ''), 'fewer answers than calls -> replay unavailable (never a prefix trade read as ours)');
  assert(/^replay unavailable/.test(readReplayAnswer([], 2).error?.message ?? ''), 'no answer -> replay unavailable (falls back to a plain check)');

  // Through the real replay wrapper: a prefix trade succeeding while the node
  // drops our call must NOT read as "call unexpectedly succeeded" (built wrong).
  const dropsOurs: Rpc = async (m) => (m === 'eth_simulateV1' ? { result: [{ calls: [ok] }] } : { result: '0x' });
  const rr = await simulateRoundTrip(replayRpc(dropsOurs, '0x10', [{ from: MID, to: TOKEN, data: '0x' }]), 'rp', trade, { v3Lender: LENDER });
  assert(rr.status === 'fail' && rr.reason.startsWith('replay unavailable') && rr.bucket === 'replay_unavailable', `dropped answer -> replay unavailable, not built wrong ("${'reason' in rr ? rr.reason : ''}")`);
  const replayed = await simulateRoundTrip(replayRpc(async () => ({ result: [{ calls: [ok, { status: '0x0', error: { code: 3, message: 'execution reverted', data: ins } }] }] }), '0x10', [{ from: MID, to: TOKEN, data: '0x' }]), 'rp2', trade, { v3Lender: LENDER });
  assert(replayed.status === 'profit', 'replayed check reads the profit');

  // ---- 5. Second opinion for "no reason" ------------------------------------
  const noReason = nodeAnswering({ error: { code: -32000, message: 'execution reverted' } });
  const lossNode = nodeAnswering({ error: { code: 3, message: 'execution reverted', data: iface.encodeErrorResult('InsufficientProfit', [0n, MAX]) } });
  const busy = nodeAnswering({ error: { code: 429, message: 'rate limited (HTTP 429)' } });
  let rechecks = 0, changed = 0;
  const note = (c: boolean) => { rechecks++; if (c) changed++; };
  const s1 = await simulateWithRecheck(noReason, lossNode, 'r1', trade, {}, note);
  assert(s1.status === 'loss' && rechecks === 1 && changed === 1, 'no reason on the checking node -> backup node answer used (would lose money)');
  const s2 = await simulateWithRecheck(noReason, busy, 'r2', trade, {}, note);
  assert(s2.status === 'fail' && isNoReasonFail(s2) && rechecks === 1, 'backup busy -> first answer kept, not counted as a re-check');
  const s3 = await simulateWithRecheck(lossNode, noReason, 'r3', trade, {}, note);
  assert(s3.status === 'loss' && rechecks === 1, 'a readable answer is never re-checked');
  const s4 = await simulateWithRecheck(noReason, null, 'r4', trade, {}, note);
  assert(isNoReasonFail(s4), 'no backup -> first answer');
  const unsupported = nodeAnswering({ error: { code: -32602, message: 'too many arguments, want at most 2' } });
  const s5 = await simulateWithRecheck(noReason, unsupported, 'r5', trade, {}, note);
  assert(isNoReasonFail(s5), "backup can't run the check -> first answer kept");
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
