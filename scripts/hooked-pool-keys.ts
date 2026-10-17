// ============================================================================
// HOOKED POOL KEYS (read-only, run on the server; sends nothing, no keys)
//
// Plain English:
//   The bot can read Uniswap V4 pools that have a hook only if it knows each
//   pool's full key (coins, fee, tick spacing, hook). The chain writes that
//   key once, in the pool's Initialize event. This script finds the event
//   for every hooked pool id in scripts/exchange-probe-pools.json (the Oct
//   16 workbook) plus any ids passed with --ids, and writes the safe ones to
//   data/robinhood-hooked-pools.json, which the bot reads at start
//   (config/robinhoodHookedPools.ts). Restart the bot after running it.
//
//   "Safe" = the hook's address flags say it cannot change a swap's amounts
//   (no "returns delta" permission), so normal V4 price maths hold. Fables
//   pools are skipped: the bot already reads them from the Fables registry.
//
//   Needs a node that keeps old logs (the paid node; the free public node
//   refuses long log searches). Uses FTM_RPC, else CHAINSTACK_RPC_ROBINHOOD,
//   else ROBINHOOD_RPC_HTTP. Never prints the node address.
//
// Run (server, repo folder):   npm run hooked-keys
//   Options: --ids 0xabc..,0xdef..   extra pool ids to look up
// ============================================================================
import 'dotenv/config';
import { ethers } from 'ethers';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { hookKeepsSwapMaths, HOOKED_POOLS_FILE } from '../src/config/robinhoodHookedPools';

const RPC = process.env.FTM_RPC || process.env.CHAINSTACK_RPC_ROBINHOOD || process.env.ROBINHOOD_RPC_HTTP || 'https://rpc.mainnet.chain.robinhood.com';
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const FABLES = '0x159a113e012593d9b3cc63ad45e30f0467e13ef3';
const T_INIT = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true, batchMaxCount: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[hooked-keys] ${m}`);

// One request, paced (~8 a second), retried on "slow down" answers.
let last = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  let err: unknown;
  for (let a = 0; a < 4; a++) {
    const w = last + 125 - Date.now(); if (w > 0) await sleep(w);
    last = Date.now();
    try { return await provider.send(method, params); }
    catch (e) { err = e; if (!/429|rate|too many|timeout|ECONN|socket/i.test(String((e as any)?.message))) throw e; await sleep(2_000 * (a + 1)); }
  }
  throw err;
}

async function main() {
  const argIds = (process.argv.includes('--ids') ? process.argv[process.argv.indexOf('--ids') + 1] ?? '' : '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^0x[0-9a-f]{64}$/.test(x));
  const pools: any[] = existsSync('scripts/exchange-probe-pools.json') ? JSON.parse(readFileSync('scripts/exchange-probe-pools.json', 'utf8')) : [];
  const label = new Map<string, string>(pools.filter((p) => p.pool.length === 66).map((p) => [p.pool.toLowerCase(), `${p.pair} (${p.dex}, ~$${Math.round(p.liq).toLocaleString('en-US')})`]));
  let ids = [...new Set([...label.keys(), ...argIds])];
  // Skip Fables pools: already read from the registry.
  try {
    const raw = await rpc('eth_call', [{ to: FABLES, data: ethers.id('activePools()').slice(0, 10) }, 'latest']);
    const [arr] = ethers.AbiCoder.defaultAbiCoder().decode(['tuple(tuple(address,address,uint24,int24,address),bytes32,bool)[]'], raw);
    const fab = new Set((arr as any[]).map((e) => String(e[1]).toLowerCase()));
    const before = ids.length; ids = ids.filter((id) => !fab.has(id));
    log(`${before - ids.length} of the ids are Fables pools (already read), skipped`);
  } catch { log('could not read the Fables registry; looking up every id'); }
  const latest = Number(await rpc('eth_blockNumber', []));
  log(`looking up ${ids.length} pool ids up to block ${latest}`);

  const keys = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const stack: [number, number][] = [[0, latest]];
    let n = 0;
    while (stack.length && n < 4_000) {
      const [f, t] = stack.pop()!; n++;
      try {
        const logs: any[] = await rpc('eth_getLogs', [{ address: PM, fromBlock: ethers.toQuantity(f), toBlock: ethers.toQuantity(t), topics: [T_INIT, chunk] }]);
        for (const l of logs) {
          const d = String(l.data).slice(2); const w = (k: number) => d.slice(k * 64, (k + 1) * 64);
          keys.set(String(l.topics[1]).toLowerCase(), { currency0: '0x' + l.topics[2].slice(26), currency1: '0x' + l.topics[3].slice(26),
            fee: Number(BigInt('0x' + w(0))), tickSpacing: Number(BigInt.asIntN(24, BigInt('0x' + w(1)))), hooks: '0x' + w(2).slice(24) });
        }
      } catch {
        if (t - f < 2_000) continue; // give up on this tiny slice
        const mid = Math.floor((f + t) / 2);
        stack.push([mid + 1, t], [f, mid]);
      }
    }
    log(`${Math.min(i + 25, ids.length)}/${ids.length} ids: ${keys.size} keys found`);
  }
  const out: any[] = [];
  let unsafe = 0, hookless = 0;
  for (const [id, k] of keys) {
    if (/^0x0{40}$/.test(k.hooks)) { hookless++; continue; }       // no hook: the normal V4 lookup covers it
    if (!hookKeepsSwapMaths(k.hooks)) { unsafe++; continue; }     // hook can change amounts: left out
    out.push({ id, ...k, label: label.get(id) ?? '' });
  }
  mkdirSync('data', { recursive: true });
  writeFileSync(HOOKED_POOLS_FILE + '.tmp', JSON.stringify({ writtenAt: new Date().toISOString(), block: latest, pools: out }, null, 1));
  renameSync(HOOKED_POOLS_FILE + '.tmp', HOOKED_POOLS_FILE);
  log(`wrote ${out.length} safe hooked pools to ${HOOKED_POOLS_FILE} (${unsafe} left out: hook can change amounts; ${hookless} have no hook; ${ids.length - keys.size} not found)`);
  log('restart the bot to start reading them (practice only)');
}
main().catch((e) => { console.error('[hooked-keys] failed:', String((e as Error).message).slice(0, 200)); process.exit(1); });
