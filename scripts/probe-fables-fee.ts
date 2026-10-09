// ============================================================================
// FABLES FEE PROBE (research, read-only, never sends anything)
//
// Plain English:
//   Fables pools sit on the normal Uniswap V4 PoolManager but each one has a
//   "hook" contract that picks the fee for every swap. This probe works out
//   how that hook picks the fee, so the bot can predict it before trading.
//
//   Part "discover" (default):
//     1. Reads every active pool from the Fables pool registry.
//     2. For each distinct hook (and the registry) it reads the contract code,
//        pulls out the function ids (4-byte selectors), looks them up in the
//        public signature database, and asks the explorer (Blockscout) if the
//        source is verified. If it is, prints the fee-related source lines.
//     3. Reads recent Swap events for the Fables pools and summarises the fee
//        actually charged, per pool, per direction and per hour of day.
//   Part "views": calls the hook's fee-looking view functions for every pool
//     at the chain head and lines them up against the most recent swap fee.
//
//   Results are printed as GitHub annotations (several, each under ~4 KB).
//
// Settings (environment):
//   FABLES_PART (discover | views | track), FABLES_HOURS of swaps to read
//   (default 6), PROBE_PACE_MS (default 700)
// Run: npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-fables-fee.js
// ============================================================================
import { ethers } from 'ethers';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const PART = process.env.FABLES_PART ?? 'discover';
const HOURS = Number(process.env.FABLES_HOURS ?? 6);
const PACE = Number(process.env.PROBE_PACE_MS ?? 700);
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/api/v2';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const REGISTRY = '0x159a113e012593d9b3cc63ad45e30f0467e13ef3';
const STATE_VIEW = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const T_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const provider = new ethers.JsonRpcProvider(URL_, 4663, { staticNetwork: true, batchMaxCount: 1 });
let lastCall = 0;
// One paced RPC call; backs off when the public node says "slow down".
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastCall + PACE - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try { return await provider.send(method, params); }
    catch (e) {
      const m = String((e as any)?.message ?? e);
      if (/403|429|rate|too many/i.test(m)) { await sleep(3_000 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw new Error(`${method}: node kept refusing`);
}

// GitHub keeps only about 10 notices per step, so extra output goes out as
// warnings (a separate allowance of 10). Each body is cut to ~3.8 KB.
let notes = 0;
function note(title: string, body: string) {
  const kind = notes++ < 10 ? 'notice' : 'warning';
  const b = body.slice(0, 3800).replace(/%/g, '%25').replace(/\r?\n/g, '%0A');
  console.log(`::${kind} title=${title}::${b}`);
  console.error(`== ${title}\n${body}\n`);
}
// Long text split over several annotations.
function noteLong(title: string, lines: string[]) {
  let chunk: string[] = [], size = 0, part = 1;
  for (const l of lines) {
    if (size + l.length + 1 > 3700 && chunk.length) { note(`${title} (${part++})`, chunk.join('\n')); chunk = []; size = 0; }
    chunk.push(l); size += l.length + 1;
  }
  if (chunk.length) note(`${title} (${part})`, chunk.join('\n'));
}

const registryIface = new ethers.Interface([
  'function activePools() view returns (tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bytes32 id, bool active)[])',
]);
type Pool = { c0: string; c1: string; fee: number; spacing: number; hooks: string; id: string };

async function readPools(): Promise<Pool[]> {
  const ret = await rpc('eth_call', [{ to: REGISTRY, data: registryIface.encodeFunctionData('activePools', []) }, 'latest']);
  const [list] = registryIface.decodeFunctionResult('activePools', ret);
  return list.map((p: any) => ({
    c0: String(p.key.currency0).toLowerCase(), c1: String(p.key.currency1).toLowerCase(),
    fee: Number(p.key.fee), spacing: Number(p.key.tickSpacing), hooks: String(p.key.hooks).toLowerCase(), id: String(p.id).toLowerCase(),
  }));
}

// Walks the bytecode opcode by opcode (skipping PUSH data) and collects every
// PUSH4 value that is compared with EQ shortly after: that is how Solidity's
// function dispatcher matches the 4-byte function id.
function selectorsOf(code: string): string[] {
  const b = Buffer.from(code.replace(/^0x/, ''), 'hex');
  const out = new Set<string>();
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op === 0x63 && i + 5 < b.length) {
      const sel = '0x' + b.subarray(i + 1, i + 5).toString('hex');
      const n1 = b[i + 5], n2 = b[i + 6];
      if (n1 === 0x14 || (n1 >= 0x80 && n1 <= 0x8f && n2 === 0x14)) out.add(sel);
    }
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // skip PUSH1..PUSH32 data
  }
  return [...out];
}

// Looks function ids up in the public signature databases.
async function lookupSelectors(sels: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < sels.length; i += 40) {
    const slice = sels.slice(i, i + 40);
    try {
      const r = await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${slice.join(',')}&filter=true`);
      const j: any = await r.json();
      for (const s of slice) {
        const hit = j?.result?.function?.[s];
        if (Array.isArray(hit) && hit.length) names.set(s, hit.map((h: any) => h.name).join(' | '));
      }
    } catch { /* database down: fall through to 4byte */ }
  }
  for (const s of sels) {
    if (names.has(s)) continue;
    try {
      const r = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${s}`);
      const j: any = await r.json();
      if (j?.results?.length) names.set(s, j.results.map((x: any) => x.text_signature).slice(0, 3).join(' | '));
    } catch { /* ignore */ }
  }
  return names;
}

async function explorer(addr: string): Promise<any> {
  try {
    const r = await fetch(`${BLOCKSCOUT}/smart-contracts/${addr}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return { status: r.status };
    return await r.json();
  } catch (e) { return { error: (e as Error).message }; }
}
async function explorerAddress(addr: string): Promise<any> {
  try {
    const r = await fetch(`${BLOCKSCOUT}/addresses/${addr}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return { status: r.status };
    return await r.json();
  } catch (e) { return { error: (e as Error).message }; }
}

type Swap = { block: number; logIndex: number; tx: string; id: string; a0: bigint; a1: bigint; sqrtP: bigint; liq: bigint; tick: number; fee: number; sender: string };
const coder = ethers.AbiCoder.defaultAbiCoder();

// Reads Swap events for the given pool ids over the last `hours`.
async function readSwaps(ids: string[], fromBlock: number, toBlock: number): Promise<Swap[]> {
  const out: Swap[] = [];
  let from = fromBlock, step = 20_000;
  while (from <= toBlock) {
    const to = Math.min(toBlock, from + step - 1);
    let logs: any[];
    try {
      logs = await rpc('eth_getLogs', [{ address: POOL_MANAGER, topics: [T_SWAP, ids], fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to) }]);
    } catch { step = Math.max(500, Math.floor(step / 4)); if (step === 500 && to - from < 500) from = to + 1; continue; }
    for (const l of logs) {
      const [a0, a1, sqrtP, liq, tick, fee] = coder.decode(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], l.data);
      out.push({ block: Number(l.blockNumber), logIndex: Number(l.logIndex), tx: l.transactionHash, id: String(l.topics[1]).toLowerCase(), sender: '0x' + String(l.topics[2]).slice(26), a0, a1, sqrtP, liq, tick: Number(tick), fee: Number(fee) });
    }
    from = to + 1;
    if (logs.length < 2000) step = Math.min(step * 2, 400_000);
  }
  return out;
}

const tokenSymbols = new Map<string, string>();
async function symbol(t: string): Promise<string> {
  if (t === ethers.ZeroAddress) return 'ETH';
  if (tokenSymbols.has(t)) return tokenSymbols.get(t)!;
  let s = t.slice(0, 8);
  try {
    const r = await rpc('eth_call', [{ to: t, data: '0x95d89b41' }, 'latest']);
    s = coder.decode(['string'], r)[0];
  } catch { /* keep the short address */ }
  tokenSymbols.set(t, s);
  return s;
}

async function discover() {
  const pools = await readPools();
  const head = Number(await rpc('eth_blockNumber', []));
  const hooks = [...new Set(pools.map((p) => p.hooks))];
  const poolLines: string[] = [];
  for (const p of pools) poolLines.push(`${p.id.slice(0, 10)} ${await symbol(p.c0)}/${await symbol(p.c1)} fee 0x${p.fee.toString(16)} spacing ${p.spacing} hook ${p.hooks.slice(0, 10)}`);
  noteLong('Fables pools', [`${pools.length} active pools, ${hooks.length} distinct hooks: ${hooks.join(', ')}`, ...poolLines]);

  // Code, selectors and explorer info for every hook and the registry.
  for (const a of [...hooks, REGISTRY]) {
    const code: string = await rpc('eth_getCode', [a, 'latest']).catch(() => '0x');
    // EIP-1967 implementation slot: is this a proxy?
    const implSlot = await rpc('eth_getStorageAt', [a, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']).catch(() => '0x');
    const impl = BigInt(implSlot || '0x0') ? '0x' + String(implSlot).slice(26) : '';
    let sels = selectorsOf(code);
    let implCode = '';
    if (impl) { implCode = await rpc('eth_getCode', [impl, 'latest']).catch(() => '0x'); sels = [...new Set([...sels, ...selectorsOf(implCode)])]; }
    const names = await lookupSelectors(sels);
    const info = await explorerAddress(a);
    const sc = await explorer(impl || a);
    const head1 = `${a === REGISTRY ? 'REGISTRY' : 'HOOK'} ${a}: code ${(code.length - 2) / 2} bytes${impl ? `, proxy -> ${impl} (${(implCode.length - 2) / 2} bytes)` : ''}; explorer name ${info?.name ?? '?'} verified ${info?.is_verified ?? '?'} creator ${info?.creator_address_hash ?? '?'}; source verified ${sc?.is_verified ?? sc?.status ?? '?'} name ${sc?.name ?? '?'} compiler ${sc?.compiler_version ?? '?'}`;
    noteLong(`Selectors ${a.slice(0, 10)}`, [head1, ...sels.map((s) => `${s} ${names.get(s) ?? '?'}`)]);
    if (sc?.abi) {
      const fns = (sc.abi as any[]).filter((x) => x.type === 'function').map((x) => `${x.name}(${(x.inputs ?? []).map((i: any) => `${i.type} ${i.name}`).join(',')}) ${x.stateMutability} -> ${(x.outputs ?? []).map((o: any) => o.type).join(',')}`);
      noteLong(`ABI ${a.slice(0, 10)}`, fns);
    }
    // Fee-related source lines (verified source only), with line numbers.
    const srcs: { file: string; code: string }[] = [];
    if (sc?.source_code) srcs.push({ file: sc.file_path ?? 'main', code: sc.source_code });
    for (const s of sc?.additional_sources ?? []) srcs.push({ file: s.file_path, code: s.source_code });
    if (srcs.length) {
      const lines: string[] = [`files: ${srcs.map((s) => s.file).join(', ')}`];
      for (const s of srcs) {
        if (/node_modules|@uniswap|lib\/|openzeppelin|solmate|v4-core|v4-periphery/i.test(s.file)) continue;
        s.code.split('\n').forEach((l, i) => { if (/fee|Fee|calendar|override|volatil|session|holiday|weekend/.test(l)) lines.push(`${s.file.split('/').pop()}:${i + 1} ${l.trim().slice(0, 160)}`); });
      }
      noteLong(`Source ${a.slice(0, 10)}`, lines.slice(0, 120));
    }
  }

  // Swap fee summary over the last HOURS hours (blocks are ~0.11 s apart).
  const fromBlock = head - Math.floor((HOURS * 3600) / 0.11);
  const swaps = await readSwaps(pools.map((p) => p.id), fromBlock, head);
  const byPool = new Map<string, Swap[]>();
  for (const s of swaps) { if (!byPool.has(s.id)) byPool.set(s.id, []); byPool.get(s.id)!.push(s); }
  const lines: string[] = [`${swaps.length} swaps over ~${HOURS} h (blocks ${fromBlock}..${head})`];
  for (const p of pools) {
    const list = byPool.get(p.id) ?? [];
    if (!list.length) continue;
    const hist = new Map<number, number>();
    for (const s of list) hist.set(s.fee, (hist.get(s.fee) ?? 0) + 1);
    const z = list.filter((s) => s.a0 < 0n), o = list.filter((s) => s.a0 >= 0n);
    const zf = [...new Set(z.map((s) => s.fee))].sort((a, b) => a - b).join('/'), of = [...new Set(o.map((s) => s.fee))].sort((a, b) => a - b).join('/');
    lines.push(`${p.id.slice(0, 10)} ${await symbol(p.c0)}/${await symbol(p.c1)} n=${list.length} fees ${[...hist].sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f}x${c}`).join(' ')} | 0->1 ${zf} | 1->0 ${of}`);
  }
  noteLong('Fee charged per pool', lines);

  // Fee changes over time for the busiest pools (block, fee) runs.
  const busy = [...byPool.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  const tl: string[] = [];
  for (const [id, list] of busy) {
    const runs: string[] = [];
    let prev = -1;
    for (const s of list.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
      if (s.fee !== prev) { runs.push(`${s.block}:${s.fee}${s.a0 < 0n ? 'z' : 'o'}`); prev = s.fee; }
    }
    tl.push(`${id.slice(0, 10)} n=${list.length} changes=${runs.length - 1}: ${runs.slice(0, 40).join(' ')}`);
  }
  noteLong('Fee timeline (block:fee, z=0->1 o=1->0)', tl);
}

(async () => {
  try {
    if (PART === 'discover') await discover();
    else note('Fables fee probe', `unknown FABLES_PART ${PART}`);
  } catch (e) { note('Fables fee probe failed', String((e as Error).stack ?? e).slice(0, 2000)); }
  process.exit(0);
})();
