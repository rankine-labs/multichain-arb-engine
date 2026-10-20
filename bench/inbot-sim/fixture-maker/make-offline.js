// ============================================================================
// OFFLINE TEST-DATA MAKER
//
// Plain English:
//   We can't reach Robinhood Chain from this machine, so this builds a small
//   practice chain (anvil) with REAL Uniswap V3 and V2 pool code, puts our
//   REAL live contract code (ARB_EXECUTOR_RUNTIME_CODE from the bot) on it,
//   then asks the practice node to check a few trades exactly like the bot
//   does (eth_call, minProfit = impossible, so the contract's refusal tells
//   the profit). For each check we save:
//     - every account / storage slot the check touched (prestateTracer)
//     - the node's answer (output, gas)
//   Both test engines must reproduce the node's answer from that data alone.
//
// Run:  node make-offline.js   (starts and stops its own anvil)
// ============================================================================
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const OUT = path.join(__dirname, '..', 'fixtures');
const ANVIL = process.env.ANVIL || `${process.env.HOME}/.foundry/bin/anvil`;
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
// Same made-up addresses the bot's own simulator uses (src/execution/simulator.ts).
const SIM_EXECUTOR = '0x00000000000000000000000000000000a7b51e00';
const SIM_CALLER = '0x00000000000000000000000000000000000b0751';
const ARBSYS = '0x0000000000000000000000000000000000000064';
const L2_BLOCK = 123456789n; // what our ArbSys stand-in reports
const MAX = (1n << 256n) - 1n;

// The live contract's runtime code, read straight from the bot's source file.
function liveRuntimeCode() {
  const src = fs.readFileSync('/home/claude/multichain-arb-engine/src/execution/arbExecutorBytecode.ts', 'utf8');
  const m = src.match(/ARB_EXECUTOR_RUNTIME_CODE\s*=\s*\n?\s*['"`](0x[0-9a-fA-F]+)['"`]/);
  if (!m) throw new Error('runtime code not found');
  return m[1];
}

// Compile our little helper contracts with solc 0.8.26 (npm build).
function compileHelpers() {
  const input = {
    language: 'Solidity',
    sources: { 'Helpers.sol': { content: fs.readFileSync(path.join(__dirname, 'Helpers.sol'), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  for (const e of out.errors || []) if (e.severity === 'error') throw new Error(e.formattedMessage);
  return out.contracts['Helpers.sol'];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // Start a fresh practice chain with Robinhood's chain id and Cancun rules.
  const anvil = spawn(ANVIL, ['--port', String(PORT), '--chain-id', '4663', '--hardfork', 'cancun',
    '--gas-limit', '1000000000', '--code-size-limit', '100000', '--silent'], { stdio: 'ignore' });
  try {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
    for (let i = 0; i < 50; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(200); } }
    const signer = await provider.getSigner(0);
    const me = await signer.getAddress();
    const H = compileHelpers();
    const deploy = async (abi, bytecode, ...args) => {
      const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...args);
      await c.waitForDeployment();
      return c;
    };

    // --- tokens (USDG 6 decimals, WETH 18, a third coin X 18) ---
    const T = H.TestToken;
    const usdg = await deploy(T.abi, T.evm.bytecode.object, 'USDG', 6);
    const weth = await deploy(T.abi, T.evm.bytecode.object, 'WETH', 18);
    const xcoin = await deploy(T.abi, T.evm.bytecode.object, 'XCOIN', 18);
    const minter = await deploy(H.V3Minter.abi, H.V3Minter.evm.bytecode.object);
    for (const t of [usdg, weth, xcoin]) {
      await (await t.mint(await minter.getAddress(), 10n ** 40n)).wait();
      await (await t.mint(me, 10n ** 40n)).wait();
    }

    // --- real Uniswap V3 factory + pools ---
    const v3f = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
    const v3p = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');
    const factory = await deploy(v3f.abi, v3f.bytecode);
    // usdPerUnit: price of one whole tokenA in tokenB; returns pool address
    async function makeV3(tokA, decA, tokB, decB, fee, priceBperA, spacing) {
      await (await factory.createPool(await tokA.getAddress(), await tokB.getAddress(), fee)).wait();
      const addr = await factory.getPool(await tokA.getAddress(), await tokB.getAddress(), fee);
      const pool = new ethers.Contract(addr, v3p.abi, signer);
      const t0 = (await pool.token0()).toLowerCase();
      const aIs0 = t0 === (await tokA.getAddress()).toLowerCase();
      // raw price token1 per token0
      let p = priceBperA * 10 ** (decB - decA);
      if (!aIs0) p = 1 / p;
      const sqrt = BigInt(Math.floor(Math.sqrt(p) * 2 ** 48)) * (1n << 48n);
      await (await pool.initialize(sqrt)).wait();
      const tick = Number((await pool.slot0()).tick);
      const base = Math.floor(tick / spacing) * spacing;
      // Several overlapping positions so bigger swaps cross many ticks (like real pools).
      for (let k = 1; k <= 12; k++) {
        const w = spacing * k * 7;
        await (await minter.mint(addr, base - w, base + w, 10n ** 15n)).wait();
      }
      return addr;
    }
    const poolA = await makeV3(weth, 18, usdg, 6, 500, 2500, 10);    // WETH/USDG 0.05%
    const poolB = await makeV3(weth, 18, usdg, 6, 3000, 2512, 60);   // WETH/USDG 0.30%, slightly higher price
    const poolX = await makeV3(xcoin, 18, usdg, 6, 3000, 1.02, 60);  // XCOIN/USDG 0.30%

    // --- real Uniswap V2 pair WETH/XCOIN ---
    const v2f = require('@uniswap/v2-core/build/UniswapV2Factory.json');
    const v2pair = require('@uniswap/v2-core/build/UniswapV2Pair.json');
    const f2 = await deploy(v2f.abi, '0x' + v2f.bytecode.replace(/^0x/, ''), me);
    await (await f2.createPair(await weth.getAddress(), await xcoin.getAddress())).wait();
    const pairAddr = await f2.getPair(await weth.getAddress(), await xcoin.getAddress());
    const pair = new ethers.Contract(pairAddr, v2pair.abi, signer);
    await (await weth.transfer(pairAddr, 400n * 10n ** 18n)).wait();
    await (await xcoin.transfer(pairAddr, 1_000_000n * 10n ** 18n)).wait(); // 1 WETH = 2500 X
    await (await pair.mint(me)).wait();

    // --- our live contract at the bot's simulator address, executor = SIM_CALLER ---
    await provider.send('anvil_setCode', [SIM_EXECUTOR, liveRuntimeCode()]);
    await provider.send('anvil_setStorageAt', [SIM_EXECUTOR, ethers.zeroPadValue('0x00', 32), ethers.zeroPadValue(SIM_CALLER, 32)]);
    await (await usdg.mint(SIM_EXECUTOR, 1_000_000n * 10n ** 6n)).wait();
    await provider.send('anvil_setBalance', [SIM_CALLER, '0x56bc75e2d63100000']);
    await provider.send('evm_mine', []);

    // --- what block context does eth_call on 'latest' use? Probe it exactly. ---
    // Runtime code: returns NUMBER, TIMESTAMP, BASEFEE, COINBASE, GASLIMIT, PREVRANDAO
    const probe = '0x' + '43600052' + '42602052' + '48604052' + '41606052' + '45608052' + '4460a052' + '60c06000f3';
    const env = await provider.send('eth_call', [{ to: '0x00000000000000000000000000000000000ccccc', data: '0x' }, 'latest',
      { '0x00000000000000000000000000000000000ccccc': { code: probe } }]);
    const w = (i) => '0x' + BigInt('0x' + env.slice(2 + 64 * i, 2 + 64 * (i + 1))).toString(16);
    const block = { number: w(0), timestamp: w(1), baseFee: w(2), coinbase: ethers.getAddress('0x' + env.slice(2 + 64 * 3 + 24, 2 + 64 * 4)),
      gasLimit: w(4), prevrandao: ethers.zeroPadValue(w(5), 32), difficulty: '0x1' };

    const iface = new ethers.Interface([
      'function execute((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps,uint24 v4Fee,int24 v4TickSpacing,bool v4Native)[] hops) t, address flashPool)',
    ]);
    if (iface.getFunction('execute').selector !== '0x8da2b32d') throw new Error('selector mismatch vs bot');
    const hop = (kind, pool, tin, tout, feeBps = 0) => ({ kind, pool, tokenIn: tin, tokenOut: tout, feeBps, v4Fee: 0, v4TickSpacing: 0, v4Native: false });
    const U = await usdg.getAddress(), W = await weth.getAddress(), X = await xcoin.getAddress();

    const cases = [
      { name: 'v3-v3-small', amountIn: 500n * 10n ** 6n, hops: [hop(2, poolA, U, W), hop(2, poolB, W, U)] },
      { name: 'v3-v3-large', amountIn: 200_000n * 10n ** 6n, hops: [hop(2, poolA, U, W), hop(2, poolB, W, U)] },
      { name: 'v3-v2-v3', amountIn: 5_000n * 10n ** 6n, hops: [hop(2, poolA, U, W), hop(0, pairAddr, W, X, 30), hop(2, poolX, X, U)] },
    ];

    // ArbSys stand-in at 0x64 (strip it from the saved state: engines model it as a precompile).
    const stubCode = H.ArbSysStub.evm.deployedBytecode.object;
    for (const withArbSys of [false, true]) {
      await provider.send('anvil_setCode', [ARBSYS, withArbSys ? '0x' + stubCode : '0x']);
      const maxBlock = withArbSys ? L2_BLOCK + 5n : BigInt(block.number) + 5n;
      for (const c of cases) {
        const data = iface.encodeFunctionData('execute', [{ token: U, amountIn: c.amountIn, minProfit: MAX, maxBlock, hops: c.hops }, ethers.ZeroAddress]);
        const tx = { from: SIM_CALLER, to: SIM_EXECUTOR, data, gas: '0x1c9c380', value: '0x0', gasPrice: '0x0' };
        const pre = await provider.send('debug_traceCall', [tx, 'latest', { tracer: 'prestateTracer' }]);
        const ct = await provider.send('debug_traceCall', [tx, 'latest', { tracer: 'callTracer' }]);
        delete pre[ARBSYS]; delete pre[ARBSYS.toLowerCase()];
        for (const k of Object.keys(pre)) if (k.toLowerCase() === ARBSYS) delete pre[k];
        // Fill defaults so every account is fully described.
        for (const a of Object.values(pre)) { a.balance ??= '0x0'; a.nonce ??= 0; a.code ??= '0x'; a.storage ??= {}; }
        const success = !ct.error;
        const fx = {
          name: `offline-${c.name}${withArbSys ? '-arbsys' : ''}`,
          source: 'local anvil (cancun, chain id 4663), real UniswapV3Pool/V2Pair bytecode, live ArbExecutor runtime code',
          chainId: 4663, block, l2BlockNumber: withArbSys ? '0x' + L2_BLOCK.toString(16) : null, tx, prestate: pre,
          expected: { success, output: ct.output ?? '0x', gasUsed: ct.gasUsed, error: ct.error ?? null,
            note: withArbSys ? 'expected gas includes a solidity ArbSys STUB (a few hundred gas more/less than a native precompile); compare output exactly, gas approximately' : 'exact' },
        };
        const file = path.join(OUT, fx.name + '.json');
        fs.writeFileSync(file, JSON.stringify(fx, null, 1));
        console.log(`${fx.name}: success=${success} out=${(fx.expected.output).slice(0, 20)}... gas=${BigInt(ct.gasUsed)} accounts=${Object.keys(pre).length} slots=${Object.values(pre).reduce((s, a) => s + Object.keys(a.storage).length, 0)}`);
      }
    }
  } finally {
    anvil.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
