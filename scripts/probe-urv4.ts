// ============================================================================
// ROUTER V4 PROBE (read-only) -- how many real Universal Router V4 swaps can
// the "Router V4 formats" reader (src/core/decoderV4Router.ts) read?
//
// Plain English:
//   1. Collects recent Uniswap V4 Swap events from the PoolManager (public
//      Robinhood node), and the transactions behind them.
//   2. Keeps the ones sent to a Universal Router the bot knows (the main one
//      and the copies in ROBINHOOD_UR_COPIES) that contain command 0x10
//      (V4_SWAP).
//   3. For every pool those swaps name, asks StateView whether it exists and
//      has liquidity, and the Fables registry which hooks are Fables.
//   4. Runs the bot's own decoder twice per transaction: switch OFF (today)
//      and switch ON (FEED_DECODE_UR_V4=1), treating every live hookless pool
//      and every Fables pool as "known". (The live bot only knows pools for
//      the pairs it watches, so its real numbers can only be equal or lower.)
//   Only reads: eth_getLogs, eth_getTransactionByHash, eth_call. Never sends.
//
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-urv4.js
//   URV4_BLOCKS (default 3000) = how many recent blocks to look at.
//   URV4_MAX_TXS (default 1500) = most transactions to fetch.
// ============================================================================
import { ethers } from 'ethers';
import { TransactionDecoder, RouterRegistry } from '../src/core/decoder';
import { seedKnownAddresses, ROBINHOOD_V4, ROBINHOOD_TOKENS } from '../src/config/knownAddresses';
import { PoolState, RawChainEvent } from '../src/core/types';
import { v4PoolKeysIn, decodeUrV4Input, V4_ACTION, V4_DYNAMIC_FEE_FLAG, UR_COMMAND_MASK, UR_CMD_V4_SWAP } from '../src/core/decoderV4Router';

const RPC = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true, batchMaxCount: 20 });
const BLOCKS = Number(process.env.URV4_BLOCKS ?? 3000);
const MAX_TXS = Number(process.env.URV4_MAX_TXS ?? 1500);
const FABLES_REGISTRY = '0x159a113e012593d9b3cc63ad45e30f0467e13ef3';
// Hard stop: print what we have after this long, whatever happens.
const DEADLINE = Date.now() + Number(process.env.URV4_MAX_MIN ?? 15) * 60_000;
const TOPIC_V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const ZERO = ethers.ZeroAddress.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eth_getLogs for V4 swaps, splitting busy ranges in half; a tiny range that
// keeps failing is retried 3 times, then skipped and counted.
let logErrors = 0;
async function v4SwapTxs(from: number, to: number): Promise<string[]> {
  const out = new Set<string>();
  const stack: [number, number, number][] = [[from, to, 0]];
  while (stack.length && Date.now() < DEADLINE && out.size < MAX_TXS) {
    const [f, t, tries] = stack.pop()!;
    try {
      const logs = await provider.send('eth_getLogs', [{ address: ROBINHOOD_V4.POOL_MANAGER, fromBlock: ethers.toQuantity(f), toBlock: ethers.toQuantity(t), topics: [TOPIC_V4_SWAP] }]) as { transactionHash: string }[];
      for (const l of logs) out.add(l.transactionHash);
    } catch {
      if (t - f >= 4) { const m = Math.floor((f + t) / 2); stack.push([m + 1, t, 0], [f, m, 0]); continue; }
      if (tries < 3) { await sleep(1_000 * (tries + 1)); stack.push([f, t, tries + 1]); continue; }
      logErrors++;
    }
  }
  return [...out].slice(0, MAX_TXS);
}

// Runs async jobs a few at a time (the public node dislikes big bursts).
async function inChunks<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length && Date.now() < DEADLINE; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = (m: Map<string, number>, n = 6) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';

async function main() {
  const reg: RouterRegistry = { avalanche: {}, monad: {}, robinhood: {} };
  seedKnownAddresses(reg);
  const isV4Router = (to?: string | null) => !!to && reg.robinhood[to.toLowerCase()]?.style === 'ur' && !!reg.robinhood[to.toLowerCase()]?.v4WrappedNative;

  const head = await provider.getBlockNumber();
  const hashes = await v4SwapTxs(Math.max(0, head - BLOCKS), head);
  const txs = (await inChunks(hashes, 10, (h) => provider.getTransaction(h).catch(() => null))).filter((t): t is ethers.TransactionResponse => !!t);

  // Universal Router transactions with at least one V4_SWAP command.
  const ur = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)', 'function execute(bytes commands, bytes[] inputs)']);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actionsSeen = new Map<string, number>(), hooksSeen = new Map<string, number>(), byRouter = new Map<string, number>();
  const picked: { tx: ethers.TransactionResponse; inputs: string[] }[] = [];
  let urTxs = 0, allowRevert = 0;
  for (const tx of txs) {
    if (!isV4Router(tx.to)) continue;
    urTxs++;
    let p: ethers.TransactionDescription | null = null;
    try { p = ur.parseTransaction({ data: tx.data }); } catch { p = null; }
    if (!p) continue;
    const cmds = ethers.getBytes(p.args[0] as string), inputs = p.args[1] as string[];
    const v4Inputs: string[] = [];
    cmds.forEach((c, i) => {
      if ((c & UR_COMMAND_MASK) !== UR_CMD_V4_SWAP || !inputs[i]) return;
      if (c & 0x80) allowRevert++;
      v4Inputs.push(inputs[i]);
      try {
        const [a] = coder.decode(['bytes', 'bytes[]'], inputs[i]);
        for (const x of ethers.getBytes(a as string)) {
          const name = Object.entries(V4_ACTION).find(([, v]) => v === x)?.[0] ?? `0x${x.toString(16)}`;
          if (name.startsWith('SWAP')) bump(actionsSeen, name);
        }
      } catch { bump(actionsSeen, 'unparseable'); }
    });
    if (v4Inputs.length) { picked.push({ tx, inputs: v4Inputs }); bump(byRouter, tx.to!.toLowerCase().slice(0, 10)); }
  }

  // Every pool named, then what the chain says about each.
  const keys = new Map<string, ReturnType<typeof v4PoolKeysIn>[number]>();
  for (const { inputs } of picked) for (const inp of inputs) for (const k of v4PoolKeysIn(inp)) { keys.set(k.id, k); if (k.hooks !== ZERO) bump(hooksSeen, k.hooks.slice(0, 10)); }
  const fables = new Set<string>();
  try {
    const iReg = new ethers.Interface(['function activePools() view returns (tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bytes32 id, bool active)[])']);
    const r = await provider.call({ to: FABLES_REGISTRY, data: iReg.encodeFunctionData('activePools') });
    for (const e of iReg.decodeFunctionResult('activePools', r)[0] as any[]) fables.add(String(e.key.hooks).toLowerCase());
  } catch { /* registry unreadable: Fables pools count as unknown */ }
  const iSV = new ethers.Interface(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)']);
  const pools = new Map<string, PoolState>();
  await inChunks([...keys.values()], 10, async (k) => {
    try {
      const [s0, l] = await Promise.all([
        provider.call({ to: ROBINHOOD_V4.STATE_VIEW, data: iSV.encodeFunctionData('getSlot0', [k.id]) }),
        provider.call({ to: ROBINHOOD_V4.STATE_VIEW, data: iSV.encodeFunctionData('getLiquidity', [k.id]) }),
      ]);
      const [sqrt, , , lpFee] = iSV.decodeFunctionResult('getSlot0', s0) as unknown as bigint[];
      const [liq] = iSV.decodeFunctionResult('getLiquidity', l) as unknown as bigint[];
      if (!(sqrt > 0n) || !(liq > 0n)) return;
      const hooked = k.hooks !== ZERO, isFables = fables.has(k.hooks);
      if (hooked && !isFables) return; // the bot only lists hookless and Fables pools
      const feePips = k.fee === V4_DYNAMIC_FEE_FLAG ? (Number(lpFee) > 0 ? Number(lpFee) : 3000) : k.fee;
      pools.set(k.id, {
        chain: 'robinhood', dex: isFables ? 'fables' : 'uniswap-v4', poolAddress: k.id, poolType: 'v3',
        tokenA: k.c0.toLowerCase() === ZERO ? ROBINHOOD_TOKENS.WETH : k.c0, tokenB: k.c1,
        sqrtPriceX96: sqrt, liquidity: liq, feeBps: Math.round(feePips / 100), feePips, lastUpdatedBlock: 0, lastUpdatedMs: Date.now(),
        v4: { fee: k.fee, tickSpacing: k.tickSpacing, native: k.c0.toLowerCase() === ZERO, poolManager: ROBINHOOD_V4.POOL_MANAGER, stateView: ROBINHOOD_V4.STATE_VIEW, hooks: hooked ? k.hooks : undefined },
      });
    } catch { /* unreadable pool: unknown */ }
  });

  // Decode: switch off (today) vs on, with the pools above as the "pool list".
  const lookup = (_c: string, id: string) => pools.get(id.toLowerCase());
  const dec = new TransactionDecoder(reg, undefined, lookup);
  const isV4Swap = (s: { poolAddress: string } | null) => !!s && s.poolAddress.length === 66;
  const reasons = new Map<string, number>();
  let readOff = 0, readOn = 0, exactOutOn = 0, hookedOn = 0;
  const dumps: string[] = [];
  for (const { tx, inputs } of picked) {
    const ev: RawChainEvent = { chain: 'robinhood', stateType: 'FINALIZED', blockOrSeq: tx.blockNumber ?? 0, receivedAtMs: Date.now(), raw: { to: tx.to, data: tx.data, value: tx.value.toString() } };
    delete process.env.FEED_DECODE_UR_V4;
    if (isV4Swap(await dec.decode(ev))) readOff++;
    process.env.FEED_DECODE_UR_V4 = '1';
    const s = await dec.decode(ev);
    if (isV4Swap(s)) { readOn++; if (s!.exactOut) exactOutOn++; if (pools.get(s!.poolAddress.toLowerCase())?.v4?.hooks) hookedOn++; }
    for (const inp of inputs) {
      const o = decodeUrV4Input(inp, { chain: 'robinhood', wrappedNative: ROBINHOOD_TOKENS.WETH, poolLookup: lookup as any, event: ev, txValue: tx.value });
      if ('reason' in o) bump(reasons, o.reason);
      // A few raw samples of formats the reader doesn't know, so the layout
      // can be checked by hand: action byte + the first 14 words of its params.
      if ('reason' in o && o.reason === 'unknown V4 router format' && dumps.length < 3) {
        try {
          const [a, p] = coder.decode(['bytes', 'bytes[]'], inp);
          const acts = ethers.getBytes(a as string), ps = p as string[];
          const j = [...acts].findIndex((x) => x >= 0x06 && x <= 0x09);
          const h = ps[j].slice(2);
          const words = Array.from({ length: Math.min(14, h.length / 64) }, (_, w) => BigInt('0x' + h.slice(w * 64, w * 64 + 64)).toString(16));
          dumps.push(`tx ${tx.hash.slice(0, 12)} action 0x0${acts[j].toString(16)} len ${h.length / 64}w: ${words.join(' ')}`);
        } catch { /* skip sample */ }
      }
    }
  }
  delete process.env.FEED_DECODE_UR_V4;

  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  console.log(`Router V4 probe: blocks ${head - BLOCKS}..${head}, V4 swap txs ${hashes.length} (fetched ${txs.length}${logErrors ? `, ${logErrors} log ranges skipped` : ''})`);
  console.log(`Sent to known Universal Routers: ${urTxs}; with command 0x10 (V4_SWAP): ${picked.length} (allow-revert flag on ${allowRevert} commands)`);
  console.log(`By router: ${top(byRouter)}`);
  console.log(`Swap actions seen: ${top(actionsSeen, 8)}`);
  console.log(`Pools named: ${keys.size}; known (live, hookless or Fables): ${pools.size}; hooks seen: ${top(hooksSeen, 5)}; Fables hooks in registry: ${fables.size}`);
  console.log(`Read as a V4 swap, switch OFF (today): ${readOff}/${picked.length} (${pct(readOff, picked.length)})`);
  console.log(`Read as a V4 swap, switch ON: ${readOn}/${picked.length} (${pct(readOn, picked.length)}); of those buy-exact ${exactOutOn}, hooked (Fables) ${hookedOn}`);
  console.log(`New reader: why not readable (per command): ${top(reasons, 8)}`);
  for (const d of dumps) console.log(`Unknown format sample: ${d}`);
}

main().catch((err) => { console.error('Router V4 probe failed:', (err as Error).message); process.exitCode = 1; });
