// ============================================================================
// SIMULATION OUTCOME BUCKETS + REVERT DATA FROM EVERY NODE STYLE
//
// Plain English:
//   A real-chain check can end many ways. This test feeds the simulator the
//   exact error shapes different nodes send back (QuickNode / Geth / Nitro,
//   Alchemy-style wrappers, Nethermind, message-only, the public node) and
//   checks each lands in the right bucket:
//     profit / real loss / token refused to move / other revert /
//     no revert data / overrides unsupported / RPC trouble / replay unavailable
//   It also checks the flash-loan check gives the contract NO pretend balance.
// ============================================================================

import { ethers } from 'ethers';
import { simulateRoundTrip, extractRevertData, replayRpc, isRateLimited, Rpc, SIM_EXECUTOR_ADDRESS } from '../execution/simulator';
import { classifySimOutcome, isTradeVerdict, SimBucketTally, SimBucket } from '../core/failReasons';
import { KIND_V2, KIND_V4_HOOKED } from '../execution/executorCalldata';
import { V4_POOL_MANAGER_STORAGE_SLOT, WETH_STORAGE_SLOT } from '../execution/arbExecutorBytecode';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const iface = new ethers.Interface([
  'error InsufficientProfit(uint256 got, uint256 wanted)',
  'error TransferFailed()',
  'error BadRoute()',
  'error Error(string)',
  'error Panic(uint256)',
]);
const MAX = (1n << 256n) - 1n;
const insufficient = (got: bigint) => iface.encodeErrorResult('InsufficientProfit', [got, MAX]);
const transferFailed = iface.encodeErrorResult('TransferFailed', []);
const badRoute = iface.encodeErrorResult('BadRoute', []);
const errStr = (s: string) => iface.encodeErrorResult('Error', [s]);
const panic = iface.encodeErrorResult('Panic', [0x11n]);
const PROFIT = 123_456_789n;

// ---- 1. Pulling revert data out of each node's error shape -----------------
const shapes: [string, unknown][] = [
  ['QuickNode / Geth / Nitro: error.data = hex', { code: 3, message: 'execution reverted', data: insufficient(PROFIT) }],
  ['public Robinhood node (Nitro): same, code 3', { code: 3, message: 'execution reverted: custom error', data: insufficient(PROFIT) }],
  ['wrapper: error.data.data', { code: -32000, message: 'execution reverted', data: { message: 'reverted', data: insufficient(PROFIT) } }],
  ['middleware: error.data.originalError.data', { code: -32603, message: 'Internal error', data: { originalError: { code: 3, data: insufficient(PROFIT), message: 'execution reverted' } } }],
  ['Nethermind: data = "Reverted 0x..."', { code: -32015, message: 'VM execution error.', data: 'Reverted ' + insufficient(PROFIT) }],
  ['doubly wrapped: error.error.data', { message: 'call failed', error: { data: insufficient(PROFIT) } }],
  ['message only: "execution reverted: 0x..."', { code: -32000, message: 'execution reverted: ' + insufficient(PROFIT) }],
];
for (const [label, e] of shapes) assert(extractRevertData(e) === insufficient(PROFIT), `revert data found: ${label}`);
assert(extractRevertData({ code: -32000, message: 'execution reverted' }) === null, 'no data anywhere -> null');
assert(extractRevertData({ code: 3, message: 'execution reverted', data: '0x' }) === '0x', 'explicitly empty data -> "0x"');
assert(extractRevertData({ message: 'caller 0x00000000000000000000000000000000000000aa not allowed' }) === null,
  'an address mentioned in a message is NOT mistaken for revert data');

// ---- 2. The rulebook on its own -------------------------------------------
const cases: [string, string, SimBucket][] = [
  ['profit', '', 'profit'],
  ['loss', '', 'real_loss'],
  ['rate_limited', 'rate limited (HTTP 429)', 'rpc_failure'],
  ['rate_limited', 'network: fetch failed', 'rpc_failure'],
  ['unsupported', 'RPC does not support eth_call state overrides', 'override_unsupported'],
  ['unsupported', 'too many arguments, want at most 2', 'override_unsupported'],
  ['unsupported', 'could not find token balance storage', 'not_simulable'],
  ['unsupported', 'V4 trade needs the chain WETH address', 'not_simulable'],
  ['fail', 'replay unavailable (state gone)', 'replay_unavailable'],
  ['fail', 'replay returned no result', 'replay_unavailable'],
  ['fail', 'execution reverted', 'missing_revert_data'],
  ['fail', 'reverted without data', 'missing_revert_data'],
  ['fail', '', 'missing_revert_data'],
  ['fail', 'TransferFailed()', 'token_transfer'],
  ['fail', 'ERC20: transfer amount exceeds balance', 'token_transfer'],
  ['fail', 'STF', 'token_transfer'],
  ['fail', 'UniswapV2: K', 'token_transfer'],
  ['fail', 'execution reverted: TRANSFER_FAILED', 'token_transfer'],
  ['fail', 'BadRoute()', 'contract_revert'],
  ['fail', 'LOK', 'contract_revert'],
  ['fail', 'Panic(17)', 'contract_revert'],
  ['fail', 'revert 0xdeadbeef', 'contract_revert'],
];
for (const [status, reason, want] of cases) {
  const got = classifySimOutcome(status, reason);
  assert(got === want, `${status} "${reason}" -> ${want}${got === want ? '' : ` (got ${got})`}`);
}
assert(isTradeVerdict('real_loss') && isTradeVerdict('profit') && !isTradeVerdict('rpc_failure') && !isTradeVerdict('missing_revert_data'),
  'only trade outcomes count as a verdict on the trade');
const tally = new SimBucketTally();
tally.add('real_loss'); tally.add('real_loss'); tally.add('rpc_failure');
assert(tally.get('real_loss') === 2 && tally.plain()[0][0] === 'would lose money', 'bucket tally counts, biggest first, in plain words');

// QuickNode's per-second limit wording is a rate limit.
assert(isRateLimited({ code: -32007, message: '15/second request limit reached - reduce calls per second' }), 'QuickNode "-32007 request limit reached" = rate limit');

// ---- 3. End to end through simulateRoundTrip --------------------------------
const TOKEN = '0x00000000000000000000000000000000000000d1';
const MID = '0x00000000000000000000000000000000000000d2';
const LENDER = '0x00000000000000000000000000000000000000e1';
const hop = (pool: string, a: string, b: string) => ({ kind: KIND_V2, pool, tokenIn: a, tokenOut: b, feeBps: 30 });
const trade = { token: TOKEN, amountIn: 10n ** 18n, hops: [hop('0x00000000000000000000000000000000000000f1', TOKEN, MID), hop('0x00000000000000000000000000000000000000f2', MID, TOKEN)] };

// A node that finds the balance slot instantly, then answers our check with `answer`.
let lastCall: any = null;
let probes = 0;
const nodeAnswering = (answer: { result?: any; error?: any }): Rpc => async (_m, params) => {
  const p = params as any[];
  if (p[0]?.data?.startsWith('0x70a08231')) { probes++; const diff = Object.values(p[2])[0] as any; return { result: Object.values(diff.stateDiff)[0] }; }
  lastCall = p;
  return answer;
};

async function main() {
  let chainN = 0;
  const run = async (answer: { result?: any; error?: any }, flash = false) =>
    simulateRoundTrip(nodeAnswering(answer), `t${chainN++}`, trade, flash ? { v3Lender: LENDER } : {});

  const p1 = await run({ error: { code: 3, message: 'execution reverted', data: insufficient(PROFIT) } });
  assert(p1.status === 'profit' && p1.profit === PROFIT && p1.bucket === 'profit', 'QuickNode-style InsufficientProfit(got>0) -> profit with the exact amount');
  const p2 = await run({ error: { code: -32015, message: 'VM execution error.', data: 'Reverted ' + insufficient(PROFIT) } });
  assert(p2.status === 'profit' && p2.profit === PROFIT, 'Nethermind-style -> same profit');
  const p3 = await run({ error: { code: -32000, message: 'execution reverted: ' + insufficient(PROFIT) } });
  assert(p3.status === 'profit' && p3.profit === PROFIT, 'message-only revert data -> same profit');

  const l1 = await run({ error: { code: 3, message: 'execution reverted', data: insufficient(0n) } });
  assert(l1.status === 'loss' && l1.bucket === 'real_loss', 'InsufficientProfit(0) -> real loss');
  const l2 = await run({ error: { code: 3, message: 'execution reverted', data: transferFailed } }, true);
  assert(l2.status === 'loss' && l2.bucket === 'real_loss' && /repaid/.test((l2 as any).detail), 'flash: TransferFailed (loan not repaid) -> real loss');
  const t1 = await run({ error: { code: 3, message: 'execution reverted', data: transferFailed } });
  assert(t1.status === 'fail' && t1.bucket === 'token_transfer', 'own capital: TransferFailed -> token refused to move');
  const t2 = await run({ error: { code: 3, message: 'execution reverted', data: errStr('ERC20: transfer amount exceeds balance') } });
  assert(t2.status === 'fail' && t2.bucket === 'token_transfer' && t2.reason === 'ERC20: transfer amount exceeds balance', 'Error("...exceeds balance") -> token refused to move');
  const t3 = await run({ error: { code: -32000, message: 'execution reverted: STF' } });
  assert(t3.status === 'fail' && t3.bucket === 'token_transfer', 'reason given only as text ("execution reverted: STF") -> token refused to move');

  const c1 = await run({ error: { code: 3, message: 'execution reverted', data: badRoute } });
  assert(c1.status === 'fail' && c1.bucket === 'contract_revert' && c1.reason === 'BadRoute()', 'BadRoute() -> contract revert');
  const c2 = await run({ error: { code: 3, message: 'execution reverted', data: panic } });
  assert(c2.status === 'fail' && c2.bucket === 'contract_revert', 'Panic -> contract revert');
  const c3 = await run({ error: { code: 3, message: 'execution reverted', data: '0xdeadbeef' } });
  assert(c3.status === 'fail' && c3.bucket === 'contract_revert' && c3.reason === 'revert 0xdeadbeef', 'unknown error code -> contract revert (code kept)');
  const c4 = await run({ result: '0x' });
  assert(c4.status === 'fail' && c4.bucket === 'contract_revert', 'call that should always refuse but succeeded -> flagged');

  const m1 = await run({ error: { code: -32000, message: 'execution reverted' } });
  assert(m1.status === 'fail' && m1.bucket === 'missing_revert_data', 'bare "execution reverted" -> missing revert data');
  const m2 = await run({ error: { code: 3, message: 'execution reverted', data: '0x' } });
  assert(m2.status === 'fail' && m2.bucket === 'missing_revert_data', 'empty "0x" data -> missing revert data');

  const r1 = await run({ error: { code: 429, message: 'rate limited (HTTP 429)' } });
  assert(r1.status === 'rate_limited' && r1.bucket === 'rpc_failure', 'HTTP 429 -> RPC failure (not a trade result)');
  const r2 = await run({ error: { code: -32007, message: '15/second request limit reached' } });
  assert(r2.status === 'rate_limited' && r2.bucket === 'rpc_failure', 'QuickNode -32007 -> RPC failure');
  const r3 = await run({ error: { message: 'network: The operation was aborted due to timeout' } });
  assert(r3.status === 'rate_limited' && r3.bucket === 'rpc_failure', 'timeout -> RPC failure');

  const o1 = await run({ error: { code: -32602, message: 'too many arguments, want at most 2' } });
  assert(o1.status === 'unsupported' && o1.bucket === 'override_unsupported', 'node without state overrides -> override unsupported');

  // Real revert data wins over a message that merely LOOKS like a rate limit.
  const w1 = await run({ error: { code: 3, message: 'execution reverted: gas allowance exceeded?', data: insufficient(PROFIT) } });
  assert(w1.status === 'profit', 'readable revert data beats a misleading message');

  // Replay unavailable (eth_simulateV1 missing / old state gone).
  const noSimV1: Rpc = async (m, params) => {
    const p = params as any[];
    if (m === 'eth_call' && p[0]?.data?.startsWith('0x70a08231')) { const diff = Object.values(p[2])[0] as any; return { result: Object.values(diff.stateDiff)[0] }; }
    return { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } };
  };
  const rp = await simulateRoundTrip(replayRpc(noSimV1, '0x10', []), 'replay', trade);
  assert(rp.status === 'fail' && rp.reason.startsWith('replay unavailable') && rp.bucket === 'replay_unavailable', 'replay not possible -> replay unavailable (reason text unchanged for callers)');

  // ---- 4. Flash check: NO pretend balance, no balance lookup --------------
  probes = 0;
  const fl = await simulateRoundTrip(nodeAnswering({ error: { code: 3, message: 'execution reverted', data: insufficient(PROFIT) } }), 'flash-chain', trade, { v3Lender: LENDER });
  const overrides = lastCall?.[2] ?? {};
  assert(fl.status === 'profit' && fl.profit === PROFIT, 'flash check reports the profit');
  assert(probes === 0, 'flash check does not look up the token balance storage (no pretend balance needed)');
  assert(!Object.keys(overrides).some((k) => k.toLowerCase() === TOKEN.toLowerCase()), 'flash check gives the contract NO token balance (like the live, empty contract)');
  assert(Object.keys(overrides).some((k) => k.toLowerCase() === SIM_EXECUTOR_ADDRESS), 'flash check still installs our contract code');
  // Own capital still gets its trade money.
  probes = 0;
  await simulateRoundTrip(nodeAnswering({ error: { code: 3, message: 'execution reverted', data: insufficient(PROFIT) } }), 'own-chain', trade);
  const own = lastCall?.[2] ?? {};
  const tokenDiff = Object.entries(own).find(([k]) => k.toLowerCase() === TOKEN.toLowerCase())?.[1] as any;
  assert(probes > 0 && tokenDiff && Object.values(tokenDiff.stateDiff)[0] === ethers.zeroPadValue(ethers.toBeHex(trade.amountIn), 32), 'own-capital check funds the contract with exactly amountIn');

  // ---- 5. Hooked V4 hop (Fables): V4 switched on with the hop's PoolManager --
  // The hop's `pool` is the hook, so the PoolManager comes from v4PoolManager.
  const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
  const HOOK = '0x06a889870C8f83640D6816319f72e2aA579b6080';
  const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
  const hookedHop = { kind: KIND_V4_HOOKED, pool: HOOK, tokenIn: MID, tokenOut: TOKEN, feeBps: 0, v4Fee: 0x800000, v4TickSpacing: 10, v4Native: true, v4PoolManager: PM };
  const hookedTrade = { ...trade, hops: [trade.hops[0], hookedHop] };
  const slotKey = (n: number) => ethers.zeroPadValue(ethers.toBeHex(n), 32).toLowerCase();
  const h1 = await simulateRoundTrip(nodeAnswering({ error: { code: 3, message: 'execution reverted', data: insufficient(PROFIT) } }), 'hooked-chain', hookedTrade, { weth: WETH });
  const hookedDiff = ((lastCall?.[2] ?? {})[SIM_EXECUTOR_ADDRESS]?.stateDiff ?? {}) as Record<string, string>;
  const diffLower = Object.fromEntries(Object.entries(hookedDiff).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  assert(h1.status === 'profit', 'hooked V4 trade simulates');
  assert(diffLower[slotKey(V4_POOL_MANAGER_STORAGE_SLOT)] === ethers.zeroPadValue(PM, 32).toLowerCase(), 'hooked hop: simulated contract points at the PoolManager, not the hook');
  assert(diffLower[slotKey(WETH_STORAGE_SLOT)] === ethers.zeroPadValue(WETH, 32).toLowerCase(), 'hooked hop: simulated contract gets WETH');
  const { v4PoolManager: _drop, ...noPm } = hookedHop;
  const h2 = await simulateRoundTrip(nodeAnswering({ result: '0x' }), 'hooked-chain-2', { ...trade, hops: [trade.hops[0], noPm] }, { weth: WETH });
  assert(h2.status === 'unsupported', 'hooked hop without its PoolManager -> unsupported, not guessed');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
