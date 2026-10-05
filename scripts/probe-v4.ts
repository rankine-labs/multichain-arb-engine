// ============================================================================
// V4 POOL PROBE -- which Uniswap V4 pools exist for the pairs we watch?
//
// Plain English:
//   Part 1 (fast, ~1 min): for every watched pair, works out the pool id of
//   each STANDARD hookless V4 pool (the 4 usual fee / tick-spacing combos,
//   with WETH and with native ETH) and asks V4's StateView whether it has
//   liquidity. Hookless pools are the only ones the contract will trade.
//   Part 2 (time-limited): reads PoolManager "Initialize" events from the
//   PoolManager's deploy block, to spot pools with non-standard settings
//   or hooks. Stops at the time limit and prints what it has.
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-v4.js
// ============================================================================
import { ethers } from 'ethers';
import { ROBINHOOD_V4, ROBINHOOD_TOKENS } from '../src/config/knownAddresses';
import { ROBINHOOD_SEED_PAIRS } from '../src/config/robinhoodSeedPairs';

const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const INIT_TOPIC = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const stateView = new ethers.Contract(ROBINHOOD_V4.STATE_VIEW, [
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
], provider);
const STANDARD: [number, number][] = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
const DEADLINE = Date.now() + Number(process.env.V4_MAX_MIN ?? 12) * 60_000;
const coder = ethers.AbiCoder.defaultAbiCoder();

const poolId = (c0: string, c1: string, fee: number, spacing: number, hooks = ethers.ZeroAddress) =>
  ethers.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, spacing, hooks]));

(async () => {
  const weth = ROBINHOOD_TOKENS.WETH.toLowerCase();
  const labelOf = new Map(ROBINHOOD_SEED_PAIRS.map((p) => [[p.a.toLowerCase(), p.b.toLowerCase()].sort().join('/'), p.label ?? '?']));

  // ---- Part 1: standard hookless pools --------------------------------------
  const found: string[] = [];
  let checked = 0;
  for (const p of ROBINHOOD_SEED_PAIRS) {
    const a = p.a.toLowerCase(), b = p.b.toLowerCase();
    const variants: Array<[string, string, boolean]> = [];
    const [x, y] = a < b ? [a, b] : [b, a];
    variants.push([x, y, false]);
    if (a === weth || b === weth) variants.push([ethers.ZeroAddress, a === weth ? b : a, true]); // native ETH version
    for (const [c0, c1, native] of variants) for (const [fee, spacing] of STANDARD) {
      checked++;
      const liq: bigint = await stateView.getLiquidity(poolId(c0, c1, fee, spacing)).catch(() => 0n);
      if (liq > 0n) found.push(`${p.label} ${native ? '(native ETH)' : ''} fee ${fee / 10000}% spacing ${spacing} liq ${liq.toString().length} digits`);
    }
  }
  console.log(`Part 1: standard hookless V4 pools with liquidity: ${found.length} (checked ${checked} pool ids for ${ROBINHOOD_SEED_PAIRS.length} pairs)`);
  for (const f of found) console.log('  ' + f);

  // ---- Part 2: every Initialize event (time-limited) -------------------------
  const latest = await provider.getBlockNumber();
  // PoolManager deploy block: binary search on "has code at block N".
  let lo = 0, hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(ROBINHOOD_V4.POOL_MANAGER, mid).catch(() => '0x');
    if (code.length > 2) hi = mid; else lo = mid + 1;
  }
  let from = lo, step = 500_000, total = 0;
  const ours: string[] = [];
  let hooked = 0, odd = 0;
  while (from <= latest && Date.now() < DEADLINE) {
    const to = Math.min(latest, from + step - 1);
    let logs: Array<{ topics: string[]; data: string }>;
    try {
      logs = await provider.send('eth_getLogs', [{ address: ROBINHOOD_V4.POOL_MANAGER, topics: [INIT_TOPIC], fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to) }]);
    } catch {
      step = Math.max(1_000, Math.floor(step / 4)); // too big: smaller chunks
      continue;
    }
    for (const l of logs) {
      total++;
      const c0 = ethers.getAddress('0x' + l.topics[2].slice(26)).toLowerCase(), c1 = ethers.getAddress('0x' + l.topics[3].slice(26)).toLowerCase();
      const [fee, spacing, hooks] = coder.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
      const n0 = c0 === ethers.ZeroAddress ? weth : c0, n1 = c1 === ethers.ZeroAddress ? weth : c1;
      const label = labelOf.get([n0, n1].sort().join('/'));
      if (!label) continue;
      const hasHook = (hooks as string) !== ethers.ZeroAddress;
      const standard = STANDARD.some(([f, s]) => f === Number(fee) && s === Number(spacing));
      if (hasHook) hooked++; else if (!standard) odd++;
      if (hasHook || !standard) ours.push(`${label}${c0 === ethers.ZeroAddress ? ' (native ETH)' : ''} fee ${Number(fee) / 10000}% spacing ${spacing} ${hasHook ? 'HOOK ' + (hooks as string).slice(0, 10) : 'no hook, NON-STANDARD'}`);
    }
    from = to + 1;
    if (logs.length < 500) step = Math.min(step * 2, 4_000_000);
  }
  const done = from > latest;
  console.log(`Part 2: ${total} V4 pools on Robinhood ${done ? '(all)' : `(stopped at the time limit, ${Math.round((100 * (from - lo)) / (latest - lo + 1))}% of history)`}; for our pairs: ${hooked} with hooks, ${odd} hookless non-standard`);
  for (const o of ours.slice(0, 25)) console.log('  ' + o);
  process.exit(0);
})().catch((e) => { console.log(`failed: ${(e as Error).message}`); process.exit(0); });
