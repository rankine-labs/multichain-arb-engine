// Builds small recorded-state fixtures (read-only) from diag1.json at the same block,
// and checks the tick maths against the chain's own quoter, exact to the last unit.
const R = '/home/ubuntu/multichain-arb-engine', OUT = '/home/ubuntu/rx/stockpx';
require(R + '/node_modules/dotenv').config({ path: R + '/.env', quiet: true });
const { ethers } = require(R + '/node_modules/ethers');
const fs = require('fs'); const TM = require(OUT + '/tickMath.js');
const url = process.env.ROBINHOOD_RPC_HTTP || process.env.CHAINSTACK_RPC_ROBINHOOD || process.env.QUICKNODE_RPC_ROBINHOOD || 'https://rpc.mainnet.chain.robinhood.com';
const prov = new ethers.JsonRpcProvider(url, 4663, { staticNetwork: true, batchMaxCount: 1 });
const ac = ethers.AbiCoder.defaultAbiCoder();
const d = JSON.parse(fs.readFileSync(OUT + '/diag1.json', 'utf8'));
const B = d.block; const PICK = (process.argv[2] || '0x6d65849d,0xfa29c8b2,0x553e9a45,0x357c92ce,0x2707cb88').split(',');
const call = async (to, data) => { try { return await prov.call({ to, data, blockTag: B }); } catch (e) { return 'ERR:' + String(e.shortMessage || e.message).slice(0, 80); } };
(async () => {
  const fx = [];
  for (const k of PICK) {
    const p = d.pools[k]; const c = p.chainNow;
    const sqrtP = BigInt(c.sqrtP), L = BigInt(c.L);
    // trim the window to +-800 ticks around the price so the fixture stays small
    const lo = Math.max(p.window.lo, c.tick - 800), hi = Math.min(p.window.hi, c.tick + 800);
    const ticks = p.window.ticks.filter((t) => t.tick >= lo && t.tick <= hi).map((t) => ({ tick: t.tick, liquidityNet: BigInt(t.liquidityNet) }));
    const win = { lo, hi, ticks, block: B, ms: 0 };
    const usdgIsA = p.tokenA.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    const cases = [];
    for (const usd of [200, 1100]) for (const zeroForOne of [true, false]) {
      const usdgIn = zeroForOne === usdgIsA; const decIn = zeroForOne ? p.decA_chain : p.decB_chain;
      const amt = usdgIn ? BigInt(usd) * 10n ** BigInt(decIn) : BigInt(Math.round((usd / p.coinUsd) * 1e9)) * 10n ** BigInt(decIn - 9);
      const fee = p.isV4 ? TM.v4SwapFeePips(Number(c.lpFee), Number(c.protocolFee), zeroForOne) : Number(c.lpFee);
      const tw = TM.swapExactInTicks({ sqrtPriceX96: sqrtP, liquidity: L, tick: c.tick, feePips: fee, window: win, zeroForOne, amountIn: amt });
      let q;
      if (p.isV4) q = await call('0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94', '0xaa9d21cb' + ac.encode(['tuple(tuple(address,address,uint24,int24,address),bool,uint128,bytes)'], [[p.key, zeroForOne, amt, '0x']]).slice(2));
      else { const [ti, to] = zeroForOne ? [p.tokenA, p.tokenB] : [p.tokenB, p.tokenA]; q = await call('0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7', '0xc6a5026a' + ac.encode(['tuple(address,address,uint256,uint24,uint160)'], [[ti, to, amt, c.lpFee, 0n]]).slice(2)); }
      const qOut = q.startsWith('0x') ? BigInt(q.slice(0, 66)).toString() : 'revert';
      cases.push({ zeroForOne, amountIn: amt.toString(), quoter: qOut, tick: tw ? tw.amountOut.toString() : null, left: tw?.leftWindow, exact: tw && qOut === tw.amountOut.toString() });
    }
    fx.push({ k, label: p.symA + '/' + p.symB, dex: p.dex, decA: p.decA_chain, decB: p.decB_chain, sqrtP: c.sqrtP, L: c.L, tick: c.tick, lpFee: c.lpFee, protocolFee: c.protocolFee ?? 0, ts: p.tickSpacing,
      win: { lo, hi, ticks: ticks.map((t) => [t.tick, t.liquidityNet.toString()]) }, cases });
  }
  fs.writeFileSync(OUT + '/fixtures.json', JSON.stringify({ block: B, fx }));
  for (const f of fx) console.log(f.k, f.label, f.cases.map((x) => (x.zeroForOne ? 'z' : 'o') + ':' + (x.exact ? 'EXACT' : x.quoter === 'revert' ? 'rev/' + (x.left ? 'LEFT' : 'in') + '/' + x.tick : 'q' + x.quoter + '/t' + x.tick)).join(' '));
})();
