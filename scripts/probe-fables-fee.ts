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
//     at the chain head, plus the stock-calendar floor for the next 7 days.
//   Part "track": follows the chain and checks currentFee(id, direction),
//     read one block before each swap and ~5 s before, against the fee paid.
//   Part "both": views then track.
//   Part "policy": replays exactly what the bot will do (one bundled read
//     every ~5 s into a FablesFeeBook, then predictFablesFeePips) and scores
//     it against the fee each real swap paid.
//
//   Results are printed as GitHub annotations (several, each under ~4 KB).
//
// Settings (environment):
//   FABLES_PART (discover | views | track | both | policy), FABLES_MINUTES
//   to follow the chain (track/policy, default 30), FABLES_HOURS of swaps to read
//   (default 6), PROBE_PACE_MS (default 700)
// Run: npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-fables-fee.js
// ============================================================================
import { ethers } from 'ethers';
import { FablesFeeBook, readFablesFees } from '../src/core/fablesFee';

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

// ---------------------------------------------------------------------------
// Bundled reads through Multicall3 (one RPC request for many view calls).
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const mc3 = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
async function callMany(calls: { target: string; data: string }[], tag: string | number = 'latest'): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  const t = typeof tag === 'number' ? ethers.toQuantity(tag) : tag;
  for (let i = 0; i < calls.length; i += 400) {
    const slice = calls.slice(i, i + 400);
    const data = mc3.encodeFunctionData('aggregate3', [slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
    try {
      const ret = await rpc('eth_call', [{ to: MC3, data }, t]);
      const [res] = mc3.decodeFunctionResult('aggregate3', ret);
      out.push(...res.map((r: any) => (r.success && r.returnData !== '0x' ? r.returnData : null)));
    } catch { out.push(...slice.map(() => null)); }
  }
  return out;
}
const SEL = (sig: string) => ethers.id(sig).slice(0, 10);
const enc = (sig: string, types: string[], vals: unknown[]) => SEL(sig) + coder.encode(types, vals).slice(2);
// All 32-byte words of a return value as short decimal numbers.
const words = (r: string | null) => (r ? (r.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt('0x' + w).toString()).join(',') : '-');
const firstWord = (r: string | null) => (r && r.length >= 66 ? Number(BigInt(r.slice(0, 66))) : null);
const curFeeCall = (p: Pool, zeroForOne: boolean) => ({ target: p.hooks, data: enc('currentFee(bytes32,bool)', ['bytes32', 'bool'], [p.id, zeroForOne]) });

// Part "views": every fee-related view of every pool, raw, at the chain head.
async function views() {
  const pools = await readPools();
  const blk = await rpc('eth_getBlockByNumber', ['latest', false]);
  const now = Number(blk.timestamp);
  const probes: [string, (p: Pool) => string][] = [
    ['cur z', (p) => enc('currentFee(bytes32,bool)', ['bytes32', 'bool'], [p.id, true])],
    ['cur o', (p) => enc('currentFee(bytes32,bool)', ['bytes32', 'bool'], [p.id, false])],
    ['auto z', (p) => enc('autonomousFee(bytes32,bool)', ['bytes32', 'bool'], [p.id, true])],
    ['auto o', (p) => enc('autonomousFee(bytes32,bool)', ['bytes32', 'bool'], [p.id, false])],
    ['flat', (p) => enc('flatFee(bytes32)', ['bytes32'], [p.id])],
    ['max', (p) => enc('maxFee(bytes32)', ['bytes32'], [p.id])],
    ['asym', (p) => enc('poolAsymmetry(bytes32)', ['bytes32'], [p.id])],
    ['poke', (p) => enc('pokeOf(bytes32)', ['bytes32'], [p.id])],
    ['pokeFloor', (p) => enc('pokeFloor(bytes32)', ['bytes32'], [p.id])],
    ['floorCfg', (p) => enc('floorConfig(bytes32)', ['bytes32'], [p.id])],
    ['open', (p) => enc('openSec(bytes32)', ['bytes32'], [p.id])],
    ['close', (p) => enc('closeSec(bytes32)', ['bytes32'], [p.id])],
    ['open1', () => SEL('openSec()')],
    ['close1', () => SEL('closeSec()')],
    ['dst', (p) => enc('dstMode(bytes32)', ['bytes32'], [p.id])],
    ['dst1', () => SEL('dstMode()')],
    ['session', (p) => enc('sessionAt(bytes32,uint256)', ['bytes32', 'uint256'], [p.id, now])],
    ['session1', () => enc('sessionAt(uint256)', ['uint256'], [now])],
    ['minFee', () => SEL('MIN_POOL_FEE()')],
    ['absMax', () => SEL('ABSOLUTE_MAX_FEE()')],
    ['spikeMult', () => SEL('MAX_SPIKE_MULT()')],
    ['descentWin', () => SEL('MAX_DESCENT_WINDOW()')],
    ['pokeTtl', () => SEL('MAX_POKE_TTL()')],
    ['pokeDisc', () => SEL('MAX_POKE_DISCOUNT_BPS()')],
    ['paused', (p) => enc('pausedFor(bytes32)', ['bytes32'], [p.id])],
  ];
  const calls = pools.flatMap((p) => probes.map(([, f]) => ({ target: p.hooks, data: f(p) })));
  const res = await callMany(calls);
  const lines: string[] = [`head ts ${now} (${new Date(now * 1000).toISOString()}) block ${Number(blk.number)}`];
  pools.forEach((p, i) => {
    const parts = probes.map(([name], j) => [name, res[i * probes.length + j]] as const).filter(([, r]) => r !== null).map(([n, r]) => `${n}=${words(r)}`);
    lines.push(`${p.id.slice(0, 10)} ${tokenSymbols.get(p.c0) ?? p.c0.slice(0, 6)}/${tokenSymbols.get(p.c1) ?? p.c1.slice(0, 6)} h${p.hooks.slice(2, 6)} ${parts.join(' ')}`);
  });
  noteLong('Fables hook views at head', lines);

  // For calendar pools: the floor fee over the next 7 days (hourly), via
  // feeFloorAt(id, floorConfig, t), to see the schedule shape.
  const sched: string[] = [];
  const cfgType = '(uint24,uint24,uint24,uint8,uint24,uint32,uint24,uint32,uint32)';
  for (const [i, p] of pools.entries()) {
    const cfgRaw = res[i * probes.length + probes.findIndex(([n]) => n === 'floorCfg')];
    if (!cfgRaw || sched.length > 14) continue;
    let cfg: any;
    try { cfg = coder.decode([cfgType], cfgRaw)[0]; } catch { continue; }
    const ts = Array.from({ length: 7 * 24 }, (_, h) => now - (now % 3600) + h * 3600);
    const r = await callMany(ts.flatMap((t) => [
      { target: p.hooks, data: enc(`feeFloorAt(bytes32,${cfgType},uint256)`, ['bytes32', cfgType, 'uint256'], [p.id, cfg, t]) },
      { target: p.hooks, data: enc(`feeFloorAt(${cfgType},uint256)`, [cfgType, 'uint256'], [cfg, t]) },
    ]));
    const vals = ts.map((t, k) => firstWord(r[2 * k]) ?? firstWord(r[2 * k + 1]));
    // Compress runs: only print where the value changes ("Th14=500").
    const runs: string[] = [];
    let prev: number | null | undefined;
    vals.forEach((v, k) => { if (v !== prev) { const d = new Date(ts[k] * 1000); runs.push(`${'SuMoTuWeThFrSa'.slice(d.getUTCDay() * 2, d.getUTCDay() * 2 + 2)}${String(d.getUTCHours()).padStart(2, '0')}=${v}`); prev = v; } });
    sched.push(`${p.id.slice(0, 10)} ${tokenSymbols.get(p.c0) ?? ''}/${tokenSymbols.get(p.c1) ?? ''} cfg ${cfg.map((x: any) => x.toString()).join(',')}: ${runs.join(' ')}`);
  }
  if (sched.length) noteLong('Calendar floor, next 7 days UTC hourly', sched);
}

// Part "track": follow the chain head for FABLES_MINUTES. For each block with
// Fables swaps, read currentFee(id, direction) at the block BEFORE (and ~5 s
// before) and compare with the fee each swap actually paid.
type Rec = { id: string; fee: number; zf: boolean; pos: number; b1: number | null; b45: number | null; amt: bigint; dtLast: number };
async function track() {
  const pools = await readPools();
  for (const p of pools) { await symbol(p.c0); await symbol(p.c1); }
  const byId = new Map(pools.map((p) => [p.id, p]));
  const ids = pools.map((p) => p.id);
  const minutes = Number(process.env.FABLES_MINUTES ?? 30);
  const stop = Date.now() + minutes * 60_000;
  let from = Number(await rpc('eth_blockNumber', []));
  const recs: Rec[] = [];
  const lastSwapBlock = new Map<string, number>();
  let skipped = 0;
  while (Date.now() < stop) {
    await sleep(1500);
    const head = Number(await rpc('eth_blockNumber', []));
    if (head <= from) continue;
    const swaps = (await readSwaps(ids, from + 1, head)).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    from = head;
    const blocks = [...new Set(swaps.map((s) => s.block))];
    for (const b of blocks) {
      // The public node keeps old state for only a few hundred blocks: skip
      // blocks we fell too far behind on rather than read failures.
      const nowHead = Number(await rpc('eth_blockNumber', []));
      if (nowHead - b > 220) { skipped++; continue; }
      const inBlock = swaps.filter((s) => s.block === b);
      const keys = [...new Set(inBlock.map((s) => `${s.id}:${s.a0 < 0n}`))];
      const calls = keys.map((k) => { const [id, z] = k.split(':'); return curFeeCall(byId.get(id)!, z === 'true'); });
      const r1 = await callMany(calls, b - 1);
      const r45 = await callMany(calls, b - 45);
      const seen = new Map<string, number>();
      for (const s of inBlock) {
        const k = `${s.id}:${s.a0 < 0n}`;
        const ki = keys.indexOf(k);
        const pos = seen.get(s.id) ?? 0; seen.set(s.id, pos + 1);
        recs.push({ id: s.id, fee: s.fee, zf: s.a0 < 0n, pos, b1: firstWord(r1[ki]), b45: firstWord(r45[ki]), amt: s.a0 < 0n ? -s.a0 : -s.a1, dtLast: b - (lastSwapBlock.get(s.id) ?? 0) });
        lastSwapBlock.set(s.id, b);
      }
    }
  }
  // Summary.
  const hookOf = (id: string) => byId.get(id)!.hooks.slice(0, 8);
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
  const first = recs.filter((r) => r.pos === 0), later = recs.filter((r) => r.pos > 0);
  const ok = (r: Rec, f: number | null) => f !== null && f === r.fee;
  const near = (r: Rec, f: number | null) => f !== null && Math.abs(f - r.fee) <= Math.max(5, r.fee * 0.02);
  const lines = [
    `${recs.length} swaps tracked over ${minutes} min, ${skipped} blocks skipped (fell behind) (${first.length} first-in-block for their pool, ${later.length} later in the same block)`,
    `currentFee at block-1, first swaps: exact ${pct(first.filter((r) => ok(r, r.b1)).length, first.length)}, within 2% ${pct(first.filter((r) => near(r, r.b1)).length, first.length)}, read failed ${first.filter((r) => r.b1 === null).length}`,
    `currentFee at block-1, later swaps: exact ${pct(later.filter((r) => ok(r, r.b1)).length, later.length)}`,
    `currentFee ~5 s before (block-45): exact ${pct(recs.filter((r) => ok(r, r.b45)).length, recs.length)}, within 2% ${pct(recs.filter((r) => near(r, r.b45)).length, recs.length)}, read failed ${recs.filter((r) => r.b45 === null).length}`,
    `conservative check (prediction >= actual): block-1 ${pct(first.filter((r) => r.b1 !== null && r.b1 >= r.fee).length, first.length)}, 5 s ${pct(recs.filter((r) => r.b45 !== null && r.b45 >= r.fee).length, recs.length)}`,
  ];
  const fam = new Map<string, Rec[]>();
  for (const r of first) { const h = hookOf(r.id); if (!fam.has(h)) fam.set(h, []); fam.get(h)!.push(r); }
  for (const [h, list] of fam) lines.push(`hook ${h}: n=${list.length} exact@b-1 ${pct(list.filter((r) => ok(r, r.b1)).length, list.length)} exact@5s ${pct(list.filter((r) => ok(r, r.b45)).length, list.length)}`);
  note('Fables fee prediction accuracy', lines.join('\n'));
  const miss = recs.filter((r) => !ok(r, r.b1)).slice(0, 60).map((r) => {
    const p = byId.get(r.id)!;
    return `${r.id.slice(0, 10)} ${tokenSymbols.get(p.c0)}/${tokenSymbols.get(p.c1)} ${r.zf ? 'z' : 'o'} pos${r.pos} paid ${r.fee} pred@b-1 ${r.b1} pred@5s ${r.b45} amtIn ${r.amt} gap ${r.dtLast}blk`;
  });
  if (miss.length) noteLong('Fables fee mispredictions (block-1)', miss);
  const stale = recs.filter((r) => ok(r, r.b1) && !ok(r, r.b45)).slice(0, 40).map((r) => `${r.id.slice(0, 10)} ${tokenSymbols.get(byId.get(r.id)!.c1)} ${r.zf ? 'z' : 'o'} paid ${r.fee} pred@5s ${r.b45}`);
  if (stale.length) noteLong('Fables fee changed within 5 s', stale);
}

// Part "policy": replays what the BOT will do. Every 45 blocks (~5 s, the
// bot's price re-sync) it reads currentFee for every Fables pool in one
// multicall (src/core/fablesFee.ts readFablesFees) into a FablesFeeBook, feeds
// it the swaps it has seen, and predicts each new swap's fee half a second
// before the swap's block. Compares with the fee the swap actually paid.
async function policy() {
  const pools = await readPools();
  for (const p of pools) { await symbol(p.c0); await symbol(p.c1); }
  const byId = new Map(pools.map((p) => [p.id, p]));
  const refs = pools.map((p) => ({ id: p.id, hooks: p.hooks }));
  const ids = pools.map((p) => p.id);
  const minutes = Number(process.env.FABLES_MINUTES ?? 30);
  const stop = Date.now() + minutes * 60_000;
  // Block -> milliseconds, measured over the last 20,000 blocks.
  const h0 = Number(await rpc('eth_blockNumber', []));
  const bA = await rpc('eth_getBlockByNumber', [ethers.toQuantity(h0), false]);
  const bB = await rpc('eth_getBlockByNumber', [ethers.toQuantity(h0 - 20_000), false]);
  const msPerBlock = ((Number(bA.timestamp) - Number(bB.timestamp)) * 1000) / 20_000;
  const ms = (b: number) => (b - h0) * msPerBlock;
  const STEP = Math.max(1, Math.round(5000 / msPerBlock));
  const book = new FablesFeeBook();
  const applied = new Set<number>();
  const applyAt = async (R: number) => {
    if (applied.has(R)) return;
    applied.add(R);
    book.applyRead(await readFablesFees((c) => callMany(c, R), refs), ms(R));
  };
  type P = { id: string; zf: boolean; paid: number; pred: number; plain: number | null; src: string };
  const out: P[] = [];
  let from = h0, skipped = 0, jumps = 0;
  while (Date.now() < stop) {
    await sleep(1500);
    const head = Number(await rpc('eth_blockNumber', []));
    if (head <= from) continue;
    const swaps = (await readSwaps(ids, from + 1, head)).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    from = head;
    for (const b of [...new Set(swaps.map((s) => s.block))]) {
      const nowHead = Number(await rpc('eth_blockNumber', []));
      if (nowHead - (b - 2 * STEP) > 230) { skipped++; continue; }
      const R = b - 1 - ((b - 1) % STEP);
      const before = new Map(pools.map((p) => [p.id, book.liveFee(p.id, true)?.feePips]));
      await applyAt(R - STEP);
      await applyAt(R);
      for (const p of pools) { const o = before.get(p.id), n = book.liveFee(p.id, true)?.feePips; if (o && n && Math.abs(n - o) > o * 0.1) jumps++; }
      const inBlock = swaps.filter((s) => s.block === b);
      for (const s of inBlock) {
        const zf = s.a0 < 0n;
        const pr = book.predict(s.id, zf, ms(b) - 500, { leadMs: 500 });
        out.push({ id: s.id, zf, paid: s.fee, pred: pr.feePips, plain: book.liveFee(s.id, zf)?.feePips ?? null, src: pr.source });
      }
      for (const s of inBlock) book.observeSwap(s.id, s.a0 < 0n, s.fee, ms(b));
    }
  }
  const n = out.length;
  const pct = (k: number) => (n ? `${((100 * k) / n).toFixed(1)}%` : '-');
  const exact = out.filter((o) => o.pred === o.paid).length;
  const w1 = out.filter((o) => Math.abs(o.pred - o.paid) <= o.paid * 0.01).length;
  const under = out.filter((o) => o.pred < o.paid);
  const plainExact = out.filter((o) => o.plain === o.paid).length;
  const fixedErr = out.reduce((a, o) => a + Math.abs(3000 - o.paid), 0) / Math.max(1, n);
  const predErr = out.reduce((a, o) => a + Math.abs(o.pred - o.paid), 0) / Math.max(1, n);
  const worstUnder = under.reduce((w, o) => Math.max(w, o.paid - o.pred), 0);
  note('Fables fee: bot policy replay (5 s refresh)', [
    `${n} swaps over ${minutes} min, ${skipped} blocks skipped (fell behind), ${msPerBlock.toFixed(1)} ms/block, refresh every ${STEP} blocks, ${jumps} fee jumps >10% between refreshes`,
    `predictFablesFeePips (book, ramp, observed floor): exact ${pct(exact)}, within 1% ${pct(w1)}, under-predicted ${pct(under.length)} (worst ${worstUnder} pips), mean abs error ${predErr.toFixed(1)} pips`,
    `plain last read, no ramp: exact ${pct(plainExact)}`,
    `old fixed 3000 pips estimate: mean abs error ${fixedErr.toFixed(0)} pips, exact ${pct(out.filter((o) => o.paid === 3000).length)}`,
    `sources: ${['hook', 'observed', 'fallback'].map((s) => `${s} ${out.filter((o) => o.src === s).length}`).join(', ')}`,
  ].join('\n'));
  const bad = out.filter((o) => o.pred !== o.paid).slice(0, 50).map((o) => `${o.id.slice(0, 10)} ${tokenSymbols.get(byId.get(o.id)!.c0)}/${tokenSymbols.get(byId.get(o.id)!.c1)} ${o.zf ? 'z' : 'o'} paid ${o.paid} pred ${o.pred} plain ${o.plain} ${o.src}`);
  if (bad.length) noteLong('Fables fee: policy misses', bad);
}

(async () => {
  try {
    if (PART === 'policy') await policy();
    else if (PART === 'discover') await discover();
    else if (PART === 'views') { for (const p of await readPools()) { await symbol(p.c0); await symbol(p.c1); } await views(); }
    else if (PART === 'track') await track();
    else if (PART === 'both') { for (const p of await readPools()) { await symbol(p.c0); await symbol(p.c1); } await views(); await track(); }
    else note('Fables fee probe', `unknown FABLES_PART ${PART}`);
  } catch (e) { note('Fables fee probe failed', String((e as Error).stack ?? e).slice(0, 2000)); }
  process.exit(0);
})();
