// ============================================================================
// SIMULATOR CHECK ON A LOCAL CHAIN (diagnostic, needs Foundry's `anvil`)
//
// Starts nothing itself: point it at a running anvil (default
// http://127.0.0.1:8545), it deploys test tokens + two pools with a price
// gap, and checks the free simulator reports the right outcomes:
//   - profitable direction  -> 'profit' with the exact amount
//   - losing direction      -> 'loss'
//   - broken route          -> 'fail' with the contract's error
//
//   anvil &   then:
//   cd contracts && forge build && cd ..
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/sim-anvil-check.js
// ============================================================================

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { makeRpc, simulateRoundTrip } from '../src/execution/simulator';
import { KIND_V2 } from '../src/execution/executorCalldata';

const RPC = process.env.ANVIL_RPC ?? 'http://127.0.0.1:8545';
// anvil's first default account (public test key, holds fake ETH only)
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const art = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'contracts', 'out', 'Mocks.sol', `${name}.json`), 'utf8'));

let failed = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!cond) failed++;
}

async function deploy(wallet: ethers.Signer, name: string, args: unknown[]) {
  const a = art(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode.object, wallet).deploy(...args);
  await c.waitForDeployment();
  return c as any;
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  // NonceManager: tracks nonces locally so quick back-to-back txs don't collide.
  const wallet = new ethers.NonceManager(new ethers.Wallet(DEV_KEY, provider));
  const E18 = 10n ** 18n;

  const usdc = await deploy(wallet, 'MockERC20', ['USDC', 18]);
  const weth = await deploy(wallet, 'MockERC20', ['WETH', 18]);
  const U = await usdc.getAddress(), W = await weth.getAddress();

  // cheap: 1 WETH = 3,000 USDC   dear: 1 WETH = 3,300 USDC
  const cheap = await deploy(wallet, 'MockV2Pair', [U, W, 30]);
  const dear = await deploy(wallet, 'MockV2Pair', [U, W, 30]);
  for (const [pair, usd] of [[cheap, 3_000_000n], [dear, 3_300_000n]] as const) {
    const addr = await pair.getAddress();
    await (await weth.mint(addr, 1_000n * E18)).wait();
    await (await usdc.mint(addr, usd * E18)).wait();
    await (await pair.sync()).wait();
  }
  const C = await cheap.getAddress(), D = await dear.getAddress();
  const rpc = makeRpc(RPC);
  const amountIn = 30_000n * E18;
  const hop = (pool: string, tIn: string, tOut: string) => ({ kind: KIND_V2, pool, tokenIn: tIn, tokenOut: tOut, feeBps: 30 });

  // 1. Profitable: buy WETH cheap, sell dear.
  const win = await simulateRoundTrip(rpc, 'anvil', { token: U, amountIn, hops: [hop(C, U, W), hop(D, W, U)] });
  check(win.status === 'profit', `profitable route -> profit (got ${JSON.stringify(win, (_, v) => typeof v === 'bigint' ? v.toString() : v)})`);
  if (win.status === 'profit') {
    // Same maths as the pools, done here independently.
    const out = (a: bigint, rIn: bigint, rOut: bigint) => (a * 9970n * rOut) / (rIn * 10_000n + a * 9970n);
    const w = out(amountIn, 3_000_000n * E18, 1_000n * E18);
    const expected = out(w, 1_000n * E18, 3_300_000n * E18) - amountIn;
    check(win.profit === expected, `exact profit matches pool maths (${ethers.formatUnits(win.profit, 18)} USDC)`);
  }

  // 2. Losing direction.
  const lose = await simulateRoundTrip(rpc, 'anvil', { token: U, amountIn, hops: [hop(D, U, W), hop(C, W, U)] });
  check(lose.status === 'loss', `losing route -> loss (got ${lose.status})`);

  // 3. Broken route: kind 7 doesn't exist.
  const bad = await simulateRoundTrip(rpc, 'anvil', { token: U, amountIn, hops: [{ ...hop(C, U, W), kind: 7 }, hop(D, W, U)] });
  check(bad.status === 'fail' && 'reason' in bad && bad.reason.startsWith('UnsupportedKind'), `broken route -> fail with reason (got ${JSON.stringify(bad)})`);

  // 5. Flash-loan version: borrow from a separate V3 pool. Profit must be
  //    the own-capital profit minus exactly the 0.05% loan fee.
  const lender = await deploy(wallet, 'MockV3Pool', [W, U, 3_000, 1, false]);
  const L = await lender.getAddress();
  await (await usdc.mint(L, 1_000_000n * E18)).wait();
  await (await weth.mint(L, 1_000n * E18)).wait();
  const flash = await simulateRoundTrip(rpc, 'anvil', { token: U, amountIn, hops: [hop(C, U, W), hop(D, W, U)] }, { v3Lender: L });
  if (win.status === 'profit' && flash.status === 'profit') {
    const fee = (amountIn * 5n + 9_999n) / 10_000n;
    check(flash.profit === win.profit - fee, `flash-loan sim = own-capital profit - loan fee (${ethers.formatUnits(flash.profit, 18)} USDC, fee ${ethers.formatUnits(fee, 18)})`);
  } else check(false, `flash-loan sim returned ${JSON.stringify(flash, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  const flashLose = await simulateRoundTrip(rpc, 'anvil', { token: U, amountIn, hops: [hop(D, U, W), hop(C, W, U)] }, { v3Lender: L });
  check(flashLose.status === 'loss', `flash-loan losing route -> loss (got ${flashLose.status})`);

  // 4. Nothing was actually changed on chain.
  check((await usdc.balanceOf(C)) === 3_000_000n * E18, 'simulation changed no real state');

  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL: crashed', e); process.exit(1); });
