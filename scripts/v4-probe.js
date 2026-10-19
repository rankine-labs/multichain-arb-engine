// ============================================================================
// V4 PROBE (one-off, READ-ONLY). Why did every live trade with a Uniswap V4
// pool fail on Oct 19? For META and PLTR (pairs that failed live):
//   1. Read every V4 pool the bot could find (all fee settings) and the
//      Uniswap V3 pools: price + liquidity, straight from the chain.
//   2. Ask our live contract (eth_call, from the bot wallet, NOTHING SENT)
//      to do a $10 round trip V3 -> V4 and V4 -> V3 with an impossible
//      profit floor. The contract then refuses with InsufficientProfit(got,
//      wanted) = what the trade REALLY returns, or another error (ZeroAmount
//      = the V4 pool gave back nothing).
// No keys, no transactions. Writes results/v4-probe.txt.
// ============================================================================
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const p = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const TOKENS = { META: '0xc0d6457c16cc70d6790dd43521c899c87ce02f35', PLTR: '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a' };
const V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'; // ROBINHOOD_V3.FACTORY
const STATE_VIEW = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const EXEC = '0x7E0f847dd429E7C15Ab08686d28710389c1F7837';
const BOT = '0x09B4fb908ff646Afa9c9878C082Add7e4b3784D6';
// Same settings list the bot uses (config/v4Tiers.ts: standard + extra).
const TIERS = [[500,10],[3000,60],[10000,200],[100,1],[200,4],[310,3],[450,9],[460,9],[500,1],[500,5],[800,5],[1000,2],[1000,10],[1200,15],[1500,15],[2000,20],[2300,23],[2400,24],[2500,25],[2690,54],[3000,30],[5000,50],[7500,75],[8000,80],[9000,90],[9900,99],[10000,100],[19000,190],[25000,250]];

const coder = ethers.AbiCoder.defaultAbiCoder();
const ZERO = ethers.ZeroAddress;
const out = [];
const log = (s) => { console.log(s); out.push(s); };

const erc20 = (a) => new ethers.Contract(a, ['function decimals() view returns (uint8)'], p);
const factory = new ethers.Contract(V3_FACTORY, ['function getPool(address,address,uint24) view returns (address)'], p);
const sv = new ethers.Contract(STATE_VIEW, ['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)', 'function getLiquidity(bytes32) view returns (uint128)'], p);
const v3 = (a) => new ethers.Contract(a, ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)'], p);

const HOP = '(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps,uint24 v4Fee,int24 v4TickSpacing,bool v4Native)';
const execIface = new ethers.Interface([
  `function execute((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,${HOP}[] hops) t, address flashPool)`,
  'error NotOwner()', 'error NotExecutor()', 'error Reentrancy()', 'error Expired()', 'error BadRoute()', 'error UnsupportedKind(uint8)',
  'error ZeroAmount()', 'error InsufficientProfit(uint256 got, uint256 wanted)', 'error TokenBalanceDropped(address token)',
  'error UnauthorizedCallback()', 'error TransferFailed()', 'error FlashPoolNotAllowed(address)', 'error V4NotEnabled()', 'error UnexpectedEth()',
]);

// USDG per token from a sqrt price (token0/token1 order by address).
function usdgPerToken(sqrtP, token, decT, decU) {
  const t0isToken = token.toLowerCase() < USDG.toLowerCase();
  const r = Number(sqrtP) / 2 ** 96; let p1per0 = r * r; // token1 per token0, raw units
  const dec0 = t0isToken ? decT : decU, dec1 = t0isToken ? decU : decT;
  p1per0 *= 10 ** (dec0 - dec1);
  return t0isToken ? p1per0 : 1 / p1per0;
}

// Ask the contract for an impossible profit: its refusal tells the real result.
async function roundTrip(hops, amountIn, block) {
  const t = { token: USDG, amountIn, minProfit: 10n ** 30n, maxBlock: BigInt(block + 100000), hops };
  const data = execIface.encodeFunctionData('execute', [t, ZERO]);
  try {
    await p.call({ from: BOT, to: EXEC, data });
    return 'no revert (unexpected)';
  } catch (e) {
    const raw = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    if (!raw || raw === '0x') return `reverted, no reason (${String(e.shortMessage || e.message).slice(0, 120)})`;
    try {
      const d = execIface.parseError(raw);
      if (d.name === 'InsufficientProfit') return `WORKS: returns ${(Number(d.args.got) / 1e6).toFixed(6)} USDG profit on ${(Number(amountIn) / 1e6)} (real result)`;
      return `FAILS: ${d.name}(${d.args.map(String).join(',')})`;
    } catch { return `reverted, raw ${String(raw).slice(0, 74)}`; }
  }
}

(async () => {
  const block = await p.getBlockNumber();
  log(`V4 probe at block ${block} (read-only, nothing sent)`);
  const decU = Number(await erc20(USDG).decimals());
  for (const [sym, tok] of Object.entries(TOKENS)) {
    const decT = Number(await erc20(tok).decimals());
    log(`\n===== ${sym}/USDG (token ${tok}, ${decT} decimals) =====`);
    const [c0, c1] = tok.toLowerCase() < USDG.toLowerCase() ? [tok, USDG] : [USDG, tok];
    const v3pools = [];
    for (const fee of [100, 500, 3000, 10000]) {
      const a = await factory.getPool(c0, c1, fee).catch(() => ZERO);
      if (!a || a === ZERO) continue;
      const [s0, L] = await Promise.all([v3(a).slot0().catch(() => null), v3(a).liquidity().catch(() => 0n)]);
      if (!s0 || L === 0n) continue;
      const px = usdgPerToken(s0[0], tok, decT, decU);
      v3pools.push({ a, fee, px });
      log(`V3  fee ${fee / 10000}%  ${a}  price ${px.toFixed(4)} USDG  L=${L}`);
    }
    const v4pools = [];
    for (const [fee, ts] of TIERS) {
      const id = ethers.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, ts, ZERO]));
      const L = await sv.getLiquidity(id).catch(() => 0n);
      if (L === 0n) continue;
      const s = await sv.getSlot0(id);
      const px = usdgPerToken(s.sqrtPriceX96, tok, decT, decU);
      v4pools.push({ id, fee, ts, px });
      log(`V4  fee ${fee / 10000}% ts ${ts}  ${id.slice(0, 12)}  price ${px.toFixed(4)} USDG  L=${L}  tick ${s.tick} lpFee ${s.lpFee}`);
    }
    // Real round trips with $10: best-liquidity V3 pool <-> each V4 pool, both directions.
    const amt = 10n * 10n ** BigInt(decU);
    for (const v of v3pools.slice(0, 2)) for (const w of v4pools) {
      const v3hopIn = { kind: 2, pool: v.a, tokenIn: USDG, tokenOut: tok, feeBps: Math.round(v.fee / 100), v4Fee: 0, v4TickSpacing: 0, v4Native: false };
      const v3hopOut = { ...v3hopIn, tokenIn: tok, tokenOut: USDG };
      const v4hopOut = { kind: 3, pool: PM, tokenIn: tok, tokenOut: USDG, feeBps: Math.round(w.fee / 100), v4Fee: w.fee, v4TickSpacing: w.ts, v4Native: false };
      const v4hopIn = { ...v4hopOut, tokenIn: USDG, tokenOut: tok };
      log(`  $10 V3(${v.fee / 10000}%) -> V4(${w.fee / 10000}%/${w.ts}): ${await roundTrip([v3hopIn, v4hopOut], amt, block)}`);
      log(`  $10 V4(${w.fee / 10000}%/${w.ts}) -> V3(${v.fee / 10000}%): ${await roundTrip([v4hopIn, v3hopOut], amt, block)}`);
    }
  }
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync('results/v4-probe.txt', out.join('\n') + '\n');
})().catch((e) => { log(`probe error: ${e.message}`); fs.mkdirSync('results', { recursive: true }); fs.writeFileSync('results/v4-probe.txt', out.join('\n') + '\n'); process.exit(0); });
