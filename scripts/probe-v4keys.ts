// ============================================================================
// V4 POOL KEY PROBE (research, read-only, never sends anything)
//
// Plain English:
//   A Uniswap V4 pool is known by an id (a fingerprint). To trade or price a
//   pool with a hook we need its full key (coins, fee, tick spacing, HOOK),
//   which the chain writes only once: in the pool's Initialize event. This
//   finds that event for every workbook V4 pool id without scanning the
//   whole chain history:
//     1. Ask StateView, at ~90 points in history (one bundled call each),
//        whether each pool had a price yet. That brackets the block each
//        pool was created in to within ~1M blocks.
//     2. Narrow each bracket down to the exact block by halving (asking
//        "price yet?" at the middle block, ~20 reads per pool).
//     3. Read the Initialize event in that one block: the full key.
//   Saves results/v4-keys.json as it goes. Also dumps the Fables registry.
// Settings: ROBINHOOD_RPC_URL, PROBE_PACE_MS (default 60), PROBE_MAX_MIN (75)
// ============================================================================
import { ethers } from 'ethers';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const PACE = Number(process.env.PROBE_PACE_MS ?? 60);
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const SV = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const FABLES = '0x159a113e012593d9b3cc63ad45e30f0467e13ef3';
const T_INIT = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const SEL_SLOT0 = ethers.id('getSlot0(bytes32)').slice(0, 10);

const provider = new ethers.JsonRpcProvider(URL_, 4663, { staticNetwork: true, batchMaxCount: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last = 0, calls = 0;
const errors: string[] = [];
async function rpc(method: string, params: unknown[]): Promise<any> {
  let lastErr: unknown;
  for (let a = 0; a < 5; a++) {
    const w = last + PACE - Date.now(); if (w > 0) await sleep(w);
    last = Date.now(); calls++;
    try { return await provider.send(method, params); }
    catch (e) { lastErr = e; const m = String((e as any)?.message ?? e); if (/revert|execution reverted/i.test(m)) throw e; await sleep(1_500 * (a + 1)); }
  }
  throw lastErr;
}
const mc = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
// Does each pool have a price at `block`? (sqrtPrice != 0)
async function hasPriceAt(ids: string[], block: number): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const data = mc.encodeFunctionData('aggregate3', [chunk.map((id) => ({ target: SV, allowFailure: true, callData: SEL_SLOT0 + id.slice(2) }))]);
    try {
      const raw = await rpc('eth_call', [{ to: MC3, data }, ethers.toQuantity(block)]);
      const [res] = mc.decodeFunctionResult('aggregate3', raw);
      for (const r of res as any[]) out.push(r.success && r.returnData.length >= 66 && BigInt(r.returnData.slice(0, 66)) !== 0n);
    } catch (e) { for (const _ of chunk) out.push(false); errors.push(`hasPriceAt ${block}: ${String((e as Error).message).slice(0, 120)}`); }
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const deadline = t0 + Number(process.env.PROBE_MAX_MIN ?? 75) * 60_000;
  const pools: any[] = JSON.parse(readFileSync('scripts/exchange-probe-pools.json', 'utf8'));
  const ids = [...new Set(pools.filter((p) => p.pool.length === 66).map((p) => p.pool.toLowerCase()))];
  const latest = Number(await rpc('eth_blockNumber', []));
  const keys: Record<string, any> = {};
  const save = (done: boolean) => { mkdirSync('results', { recursive: true }); writeFileSync('results/v4-keys.json', JSON.stringify({ done, latest, calls, seconds: Math.round((Date.now() - t0) / 1000), keys, fables, errors: errors.slice(0, 200) }, null, 1)); };
  // Fables registry, for reference (its pools carry their keys).
  let fables: any[] = [];
  try {
    const raw = await rpc('eth_call', [{ to: FABLES, data: ethers.id('activePools()').slice(0, 10) }, 'latest']);
    const [arr] = ethers.AbiCoder.defaultAbiCoder().decode(['tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bytes32 id,bool active)[]'], raw);
    fables = (arr as any[]).map((e) => ({ id: String(e.id).toLowerCase(), currency0: String(e.key.currency0).toLowerCase(), currency1: String(e.key.currency1).toLowerCase(), fee: Number(e.key.fee), tickSpacing: Number(e.key.tickSpacing), hooks: String(e.key.hooks).toLowerCase(), active: e.active }));
  } catch (e) { errors.push(`fables: ${(e as Error).message.slice(0, 100)}`); }
  // Archive check: a pool created at block 44,905 must have a price at 100,000.
  const arch = await hasPriceAt(['0x' + 'f'.repeat(64)], 100_000).catch(() => [false]);
  console.log(`[v4keys] ${ids.length} ids, latest ${latest}, archive call ok: ${arch.length === 1}`);

  // 1) Brackets.
  const STEP = 1_000_000;
  const points: number[] = []; for (let b = STEP; b < latest; b += STEP) points.push(b); points.push(latest);
  const firstSeen = new Map<string, number>(); // index into points
  const now = await hasPriceAt(ids, latest);
  const live = ids.filter((_, i) => now[i]);
  console.log(`[v4keys] ${live.length}/${ids.length} ids have a price on the Uniswap V4 PoolManager now`);
  for (let k = 0; k < points.length; k++) {
    const todo = live.filter((id) => !firstSeen.has(id));
    if (!todo.length) break;
    const r = await hasPriceAt(todo, points[k]);
    todo.forEach((id, i) => { if (r[i]) firstSeen.set(id, k); });
  }
  console.log(`[v4keys] bracketed ${firstSeen.size}/${live.length} (${calls} requests)`);
  // 2) + 3) Exact block, then the Initialize log.
  let n = 0;
  for (const id of live) {
    if (Date.now() > deadline) { errors.push('deadline'); break; }
    const k = firstSeen.get(id); if (k === undefined) continue;
    let lo = k === 0 ? 0 : points[k - 1], hi = points[k]; // price at hi, none at lo
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const [p] = await hasPriceAt([id], mid);
      if (p) hi = mid; else lo = mid;
    }
    try {
      const logs: any[] = await rpc('eth_getLogs', [{ address: PM, fromBlock: ethers.toQuantity(hi), toBlock: ethers.toQuantity(hi), topics: [T_INIT, id] }]);
      for (const l of logs) {
        const d = String(l.data).slice(2); const w = (i: number) => d.slice(i * 64, (i + 1) * 64);
        keys[id] = { block: hi, currency0: '0x' + l.topics[2].slice(26), currency1: '0x' + l.topics[3].slice(26), fee: Number(BigInt('0x' + w(0))),
          tickSpacing: Number(BigInt.asIntN(24, BigInt('0x' + w(1)))), hooks: '0x' + w(2).slice(24) };
      }
      if (!logs.length) errors.push(`no Initialize log at ${hi} for ${id.slice(0, 10)}`);
    } catch (e) { errors.push(`logs ${id.slice(0, 10)}@${hi}: ${(e as Error).message.slice(0, 100)}`); }
    if (++n % 10 === 0) { save(false); console.log(`[v4keys] ${n}/${firstSeen.size} keys (${Object.keys(keys).length} found, ${calls} requests)`); }
  }
  save(true);
  console.log(`[v4keys] done: ${Object.keys(keys).length} keys, ${calls} requests, ${Math.round((Date.now() - t0) / 1000)} s`);
}
main().catch((e) => { console.error(e); process.exit(1); });
