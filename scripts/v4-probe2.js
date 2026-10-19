// ============================================================================
// FAILED LIVE TRADES vs THEIR TRIGGERS (one-off, READ-ONLY).
// For each trade the bot wallet sent on Oct 19: our route (from the calldata),
// the transactions just before ours in the same block (the trigger we
// followed), and every Uniswap V3 / V4 Swap they emitted: which pool, which
// way, how much, and the REAL price right after. Compared with the prices of
// the two pools in our route. No keys, nothing sent. Writes results/v4-probe2.txt.
// ============================================================================
const { ethers } = require('ethers');
const fs = require('fs');
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const p = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
const BOT = '0x09B4fb908ff646Afa9c9878C082Add7e4b3784D6';
const EXEC = '0x7E0f847dd429E7C15Ab08686d28710389c1F7837'.toLowerCase();
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951'.toLowerCase();
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const out = []; const log = (s) => { console.log(s); out.push(s); };

const HOP = '(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps,uint24 v4Fee,int24 v4TickSpacing,bool v4Native)';
const iface = new ethers.Interface([`function execute((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,${HOP}[] hops) t, address flashPool)`]);
const coder = ethers.AbiCoder.defaultAbiCoder();
const V3_SWAP = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const dec = {}; const sym = {};
async function meta(t) {
  t = t.toLowerCase();
  if (dec[t] === undefined) {
    const c = new ethers.Contract(t, ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'], p);
    dec[t] = Number(await c.decimals().catch(() => 18)); sym[t] = await c.symbol().catch(() => t.slice(0, 8));
  }
  return { d: dec[t], s: sym[t] };
}
// USDG per token from a sqrt price, given the pool's token0/token1.
async function px(sqrtP, t0, t1) {
  const a = await meta(t0), b = await meta(t1);
  const r = Number(sqrtP) / 2 ** 96; const p1per0 = r * r * 10 ** (a.d - b.d);
  if (t1.toLowerCase() === USDG) return `${p1per0.toFixed(4)} USDG per ${a.s}`;
  if (t0.toLowerCase() === USDG) return `${(1 / p1per0).toFixed(4)} USDG per ${b.s}`;
  return `${p1per0.toPrecision(6)} ${b.s} per ${a.s}`;
}
const v3tokens = {};
async function v3pair(addr) {
  if (!v3tokens[addr]) { const c = new ethers.Contract(addr, ['function token0() view returns (address)', 'function token1() view returns (address)'], p); v3tokens[addr] = [await c.token0(), await c.token1()]; }
  return v3tokens[addr];
}
const v4id = (c0, c1, fee, ts) => ethers.keccak256(coder.encode(['address','address','uint24','int24','address'], [c0, c1, fee, ts, ethers.ZeroAddress])).toLowerCase();

async function swapsIn(receipt) {
  const lines = [];
  for (const l of receipt.logs) {
    if (l.topics[0] === V3_SWAP) {
      const [a0, a1, sq] = coder.decode(['int256','int256','uint160','uint128','int24'], l.data);
      const [t0, t1] = await v3pair(l.address).catch(() => [null, null]);
      if (!t0) continue;
      lines.push(`      V3 swap  pool ${l.address}  amount0 ${a0}  amount1 ${a1}  -> ${await px(sq, t0, t1)}`);
    } else if (l.topics[0] === V4_SWAP && l.address.toLowerCase() === PM) {
      const [a0, a1, sq, L, tick, fee] = coder.decode(['int128','int128','uint160','uint128','int24','uint24'], l.data);
      lines.push(`      V4 swap  id ${l.topics[1].slice(0, 12)}  amount0 ${a0}  amount1 ${a1}  fee ${fee}  sqrtP ${sq}`);
    }
  }
  return lines;
}

(async () => {
  // Bot trades: scan the blocks of the live window (Oct 19, 19:05-20:10 UTC)
  // for transactions from the bot wallet. Plain block reads, no explorer.
  let txs = [];
  const at = async (n) => (await p.getBlock(n)).timestamp;
  const findBlock = async (ts) => { let lo = 92700000, hi = await p.getBlockNumber(); while (lo < hi) { const m = Math.floor((lo + hi) / 2); if ((await at(m)) < ts) lo = m + 1; else hi = m; } return lo; };
  const from = await findBlock(Date.UTC(2026, 9, 19, 19, 5) / 1000), to = await findBlock(Date.UTC(2026, 9, 19, 20, 10) / 1000);
  log(`scanning blocks ${from}..${to} (${to - from} blocks) for bot transactions`);
  const bot = BOT.toLowerCase();
  for (let b = from; b <= to; b += 200) {
    const nums = []; for (let k = b; k < Math.min(b + 200, to + 1); k++) nums.push(k);
    const blocks = await Promise.all(nums.map((n) => p.send('eth_getBlockByNumber', ['0x' + n.toString(16), true]).catch(() => null)));
    for (const bl of blocks) for (const x of bl?.transactions || []) if ((x.from || '').toLowerCase() === bot) txs.push({ hash: x.hash, to: x.to, timestamp: new Date(Number(bl.timestamp) * 1000).toISOString() });
  }
  txs.reverse();
  txs = txs.filter((t) => (t.to || '').toLowerCase() === EXEC).slice(0, 20);
  log(`${txs.length} bot trades found (newest first)\n`);
  for (const t of txs) {
    const tx = await p.getTransaction(t.hash); const rc = await p.getTransactionReceipt(t.hash);
    let route = '?';
    try {
      const d = iface.decodeFunctionData('execute', tx.data);
      const hops = d[0].hops;
      const parts = [];
      for (const h of hops) {
        const a = await meta(h.tokenIn), b = await meta(h.tokenOut);
        if (Number(h.kind) === 3) {
          const [c0, c1] = h.tokenIn.toLowerCase() < h.tokenOut.toLowerCase() ? [h.tokenIn, h.tokenOut] : [h.tokenOut, h.tokenIn];
          parts.push(`${a.s}->${b.s} on V4 id ${v4id(c0, c1, Number(h.v4Fee), Number(h.v4TickSpacing)).slice(0, 12)} (fee ${h.v4Fee}, ts ${h.v4TickSpacing})`);
        } else parts.push(`${a.s}->${b.s} on kind${h.kind} ${h.pool}`);
      }
      route = `$${(Number(d[0].amountIn) / 1e6).toFixed(2)} | ${parts.join('  then  ')}`;
    } catch (e) { route = `could not decode (${e.message.slice(0, 60)})`; }
    log(`=== ${t.timestamp}  block ${rc.blockNumber} pos ${rc.index}  status ${rc.status ? 'OK' : 'REVERTED'}  ${t.hash}`);
    log(`  our route: ${route}`);
    const blk = await p.getBlock(rc.blockNumber, true);
    const before = blk.prefetchedTransactions.filter((x) => x.index < rc.index && x.from.toLowerCase() !== BOT.toLowerCase());
    if (!before.length) log('  no other transaction before ours in this block (trigger was in an earlier block)');
    for (const x of before.slice(-3)) {
      const xr = await p.getTransactionReceipt(x.hash);
      const sw = await swapsIn(xr);
      log(`  before us: pos ${x.index} ${x.hash.slice(0, 14)} to ${x.to} (${sw.length} swaps)`);
      for (const s of sw) log(s);
    }
    log('');
  }
  fs.mkdirSync('results', { recursive: true }); fs.writeFileSync('results/v4-probe2.txt', out.join('\n') + '\n');
})().catch((e) => { log(`probe error: ${e.stack || e.message}`); fs.mkdirSync('results', { recursive: true }); fs.writeFileSync('results/v4-probe2.txt', out.join('\n') + '\n'); });
