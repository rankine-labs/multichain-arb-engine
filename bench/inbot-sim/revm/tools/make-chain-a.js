// ============================================================================
// make-chain-a.js — builds the "tx A" calldata for the CHAINED test.
//
// Plain English: the fixtures' trades all lose money, so they revert and change
// nothing. For a chained test we need a tx A that REALLY changes pool state.
// We take the fixture's own trade, reverse the route (sell where it bought,
// buy where it sold) and set minProfit = 1 wei, so the contract actually swaps.
// Prints the hex calldata on stdout.
//
// Usage: node tools/make-chain-a.js <fixture.json> [reverse|same]
// ============================================================================
// ethers: use whichever copy exists (this sandbox, or the bot's own install on the server).
const { ethers } = (() => {
  for (const p of ['/home/claude/inbot-bench/fixture-maker/node_modules/ethers', `${process.env.HOME}/multichain-arb-engine/node_modules/ethers`, 'ethers']) {
    try { return require(p); } catch { /* try next */ }
  }
  throw new Error('ethers not found');
})();
const fx = require(require('path').resolve(process.argv[2]));
const mode = process.argv[3] || 'reverse';
const iface = new ethers.Interface([
  'function execute((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps,uint24 v4Fee,int24 v4TickSpacing,bool v4Native)[] hops) t, address flashPool)',
  'function executeWithV3Flash((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps,uint24 v4Fee,int24 v4TickSpacing,bool v4Native)[] hops) t, address lendPool)',
]);
// Live trades may use either entry point (own money, or V3 flash loan); keep the same one.
const fn = iface.parseTransaction({ data: fx.tx.data }).name;
const [t, flash] = iface.decodeFunctionData(fn, fx.tx.data);
let hops = t.hops.map((h) => ({ kind: h.kind, pool: h.pool, tokenIn: h.tokenIn, tokenOut: h.tokenOut,
  feeBps: h.feeBps, v4Fee: h.v4Fee, v4TickSpacing: h.v4TickSpacing, v4Native: h.v4Native }));
if (mode === 'reverse') hops = hops.reverse().map((h) => ({ ...h, tokenIn: h.tokenOut, tokenOut: h.tokenIn }));
const amountIn = process.argv[4] ? BigInt(process.argv[4]) : t.amountIn;
process.stdout.write(iface.encodeFunctionData(fn, [{ token: t.token, amountIn, minProfit: 1n, maxBlock: t.maxBlock, hops }, flash]));
