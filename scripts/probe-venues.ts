// ============================================================================
// VENUE PROBE (research, read-only, never sends anything)
//
// Plain English:
//   1. IDENTIFY: for every exchange contract we know of (old and new), check
//      it really exists on chain and ask the public explorer (Blockscout)
//      for its verified contract name.
//   2. FIND POOLS: read recent blocks, collect every swap, and ask each pool
//      which factory made it. That ties pools to exchanges with full
//      addresses, no guessing.
//   3. VALIDATE: for a sample of real swaps on each exchange, read the pool's
//      state one block BEFORE the swap and run our own maths
//      (src/core/venueMath.ts). If our predicted output matches what the
//      pool actually paid, our pricing for that exchange is right.
//
//   Results are printed as GitHub annotations (one per exchange).
//
// Settings (environment):
//   PROBE_WINDOWS (default 6), PROBE_WINDOW blocks each (default 150),
//   PROBE_HOURS spread back (default 3), PROBE_PACE_MS (default 700),
//   PROBE_SWAPS_PER_VENUE validations (default 10)
// Run: npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-venues.js
// ============================================================================
import { ethers } from 'ethers';
import { ROBINHOOD_SCAN_FACTORIES, ROBINHOOD_V4 } from '../src/config/knownAddresses';
import { ROBINHOOD_VENUES } from '../src/config/robinhoodVenues';
import { clAmountOut, v2AmountOut, errorBps } from '../src/core/venueMath';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const WINDOWS = Number(process.env.PROBE_WINDOWS ?? 4);
const WINDOW = Number(process.env.PROBE_WINDOW ?? 100);
const HOURS = Number(process.env.PROBE_HOURS ?? 3);
const PACE = Number(process.env.PROBE_PACE_MS ?? 700);
const PER_VENUE = Number(process.env.PROBE_SWAPS_PER_VENUE ?? 15);
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/api/v2';
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const T_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const T_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_PCS = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
const T_V4 = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const T_TESSERA = ethers.id('TesseraTrade(address,address,uint256,uint256,address)');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const provider = new ethers.JsonRpcProvider(URL_, 4663, { staticNetwork: true, batchMaxCount: 1 });
let lastCall = 0;
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

const mc3 = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
async function callMany(calls: { target: string; data: string }[], blockTag: string | number = 'latest'): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  const tag = typeof blockTag === 'number' ? ethers.toQuantity(blockTag) : blockTag;
  for (let i = 0; i < calls.length; i += 300) {
    const slice = calls.slice(i, i + 300);
    const data = mc3.encodeFunctionData('aggregate3', [slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
    try {
      const ret = await rpc('eth_call', [{ to: MC3, data }, tag]);
      const [res] = mc3.decodeFunctionResult('aggregate3', ret);
      out.push(...res.map((r: any) => (r.success && r.returnData !== '0x' ? r.returnData : null)));
    } catch { out.push(...slice.map(() => null)); }
  }
  return out;
}
const word = (r: string | null, i: number): bigint | null => (r && r.length >= 2 + 64 * (i + 1) ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null);
const signed = (v: bigint, bits = 256) => (v >= 1n << BigInt(bits - 1) ? v - (1n << BigInt(bits)) : v);
const addr = (r: string | null) => (r && r.length >= 66 ? '0x' + r.slice(26, 66).toLowerCase() : null);
const SEL = (sig: string) => ethers.id(sig).slice(0, 10);

function note(title: string, body: string) {
  const b = body.replace(/%/g, '%25').replace(/\r?\n/g, '%0A');
  console.log(`::notice title=${title}::${b}`);
  console.error(`== ${title}\n${body}\n`);
}

async function blockscoutName(a: string): Promise<string> {
  try {
    const r = await fetch(`${BLOCKSCOUT}/addresses/${a}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return `explorer ${r.status}`;
    const j: any = await r.json();
    const impl = Array.isArray(j.implementations) && j.implementations[0] ? ` impl ${j.implementations[0].name ?? ''} ${j.implementations[0].address_hash ?? j.implementations[0].address ?? ''}` : '';
    return `${j.name ?? '(no name)'}${j.is_verified ? ' [verified]' : ''}${j.creator_address_hash ? ` creator ${j.creator_address_hash}` : ''}${impl}`;
  } catch (e) { return `explorer error ${(e as Error).message.slice(0, 60)}`; }
}

type SwapLog = { block: number; logIndex: number; address: string; topics: string[]; data: string; tx: string };

async function main() {
  const latest = Number(await rpc('eth_blockNumber', []));
  // ---- 1. identify ----------------------------------------------------------
  const known = [
    ...ROBINHOOD_SCAN_FACTORIES.map((f) => ({ name: f.dex, address: f.factory })),
    ...ROBINHOOD_VENUES.flatMap((v) => v.contracts.map((c) => ({ name: `${v.id}:${c.role}`, address: c.address }))),
    { name: 'unknown-9a8442', address: '0x9a8442cb89fe713ce7c2f22852e61fbffee97ecf' },
    { name: 'unknown-e7fef2', address: '0xe7fef2bc860b25bbdeb6f6ab96d88baaa77ddad7' },
  ];
  const idLines: string[] = [];
  for (const k of known) {
    const code = await rpc('eth_getCode', [k.address, 'latest']).catch(() => '0x');
    const name = await blockscoutName(k.address);
    idLines.push(`${k.name} ${k.address}: code ${(code.length - 2) / 2} bytes; ${name}`);
  }
  note('Venue contracts (code + explorer name)', idLines.join('\n'));

  // ---- 2. find pools from recent swaps --------------------------------------
  const swaps: SwapLog[] = [];
  const blockLogs = new Map<number, SwapLog[]>();
  const step = Math.floor((HOURS * 3600 / 0.11) / Math.max(1, WINDOWS));
  let tessera = 0, ekuboLogs = 0;
  const ekubo = ROBINHOOD_VENUES.find((v) => v.id === 'ekubo')?.contracts.find((c) => c.role === 'core')?.address.toLowerCase();
  for (let w = 0; w < WINDOWS; w++) {
    const end = latest - 20 - w * step;
    for (let b = end - WINDOW + 1; b <= end; b++) {
      let rcpts: any[] = [];
      try { rcpts = await rpc('eth_getBlockReceipts', [ethers.toQuantity(b)]); } catch { continue; }
      const list: SwapLog[] = [];
      for (const rc of rcpts ?? []) for (const l of rc.logs ?? []) {
        const t0 = l.topics?.[0];
        const a = String(l.address).toLowerCase();
        if (t0 === T_TESSERA) tessera++;
        if (ekubo && a === ekubo) ekuboLogs++;
        if (t0 !== T_V2 && t0 !== T_V3 && t0 !== T_PCS && t0 !== T_V4) continue;
        list.push({ block: b, logIndex: Number(l.logIndex), address: a, topics: l.topics, data: l.data, tx: rc.transactionHash });
      }
      blockLogs.set(b, list);
      swaps.push(...list);
    }
  }
  // Pool -> factory (one bundled read; V4 swaps are keyed by pool id instead).
  const poolAddrs = [...new Set(swaps.filter((s) => s.topics[0] !== T_V4).map((s) => s.address))];
  const facRes = await callMany(poolAddrs.map((p) => ({ target: p, data: SEL('factory()') })));
  const factoryOf = new Map<string, string>();
  poolAddrs.forEach((p, i) => { const f = addr(facRes[i]); if (f) factoryOf.set(p, f); });
  // Fables pools: ids registered in the Fables registry.
  const fables = ROBINHOOD_VENUES.find((v) => v.id === 'fables');
  const fablesIds = new Set<string>();
  const reg = fables?.contracts.find((c) => c.role === 'registry')?.address;
  if (reg) {
    const iface = new ethers.Interface(['function activePools() view returns (tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bytes32 id, bool active)[])']);
    try {
      const ret = await rpc('eth_call', [{ to: reg, data: iface.encodeFunctionData('activePools') }, 'latest']);
      for (const p of iface.decodeFunctionResult('activePools', ret)[0]) fablesIds.add(String(p.id).toLowerCase());
    } catch (e) { note('Fables registry', `activePools() failed: ${(e as Error).message.slice(0, 120)}`); }
  }
  const venueOf = (s: SwapLog): string => {
    if (s.topics[0] === T_V4) return fablesIds.has(s.topics[1].toLowerCase()) ? 'fables' : 'uniswap-v4 (other)';
    const f = factoryOf.get(s.address);
    if (!f) return 'no factory()';
    const known1 = ROBINHOOD_SCAN_FACTORIES.find((x) => x.factory.toLowerCase() === f);
    if (known1) return known1.dex;
    const v = ROBINHOOD_VENUES.find((x) => x.contracts.some((c) => c.address.toLowerCase() === f));
    return v ? v.id : `factory ${f}`;
  };
  const byVenue = new Map<string, SwapLog[]>();
  for (const s of swaps) { const v = venueOf(s); (byVenue.get(v) ?? byVenue.set(v, []).get(v)!).push(s); }
  note('Swaps by exchange (sampled blocks)', [
    `${WINDOWS} windows x ${WINDOW} blocks, latest ${latest}. Swaps: ${swaps.length}. Tessera trades: ${tessera}. Ekubo core logs: ${ekuboLogs}. Fables pool ids registered: ${fablesIds.size}.`,
    ...[...byVenue.entries()].sort((a, b) => b[1].length - a[1].length).map(([v, l]) => `${v}: ${l.length} swaps, ${new Set(l.map((x) => x.topics[0] === T_V4 ? x.topics[1] : x.address)).size} pools, topic ${l[0].topics[0].slice(0, 10)}`),
  ].join('\n'));

  // ---- 3. validate our maths on real swaps (at the chain head) -------------
  // The public node only keeps recent state (a few hundred blocks, i.e.
  // seconds on this chain), so each swap is checked right after its block
  // appears: read the newest block, then the pool state one block before.
  const stats = new Map<string, { tested: number; inBand: number[]; price: number[]; crossed: number; earlier: number; feeMismatch: number; lines: string[]; feeExamples: string[] }>();
  const st = (v: string) => stats.get(v) ?? stats.set(v, { tested: 0, inBand: [], price: [], crossed: 0, earlier: 0, feeMismatch: 0, lines: [], feeExamples: [] }).get(v)!;
  const wanted = (v: string) => !v.startsWith('factory ') && v !== 'no factory()' && v !== 'uniswap-v4 (other)';
  const deadline = Date.now() + Number(process.env.PROBE_VALIDATE_MIN ?? 14) * 60_000;
  let lastSeen = 0;
  let firstErr = '';
  while (Date.now() < deadline) {
    const head = Number(await rpc('eth_blockNumber', []));
    if (head === lastSeen) { await sleep(300); continue; }
    lastSeen = head;
    let rcpts: any[] = [];
    try { rcpts = await rpc('eth_getBlockReceipts', [ethers.toQuantity(head)]); } catch { continue; }
    const list: SwapLog[] = [];
    for (const rc of rcpts ?? []) for (const l of rc.logs ?? []) {
      const t0 = l.topics?.[0];
      if (t0 !== T_V2 && t0 !== T_V3 && t0 !== T_PCS && t0 !== T_V4) continue;
      list.push({ block: head, logIndex: Number(l.logIndex), address: String(l.address).toLowerCase(), topics: l.topics, data: l.data, tx: rc.transactionHash });
    }
    // New pools: who made them (one bundled read).
    const unknownPools = [...new Set(list.filter((x) => x.topics[0] !== T_V4 && !factoryOf.has(x.address)).map((x) => x.address))];
    if (unknownPools.length) {
      const r = await callMany(unknownPools.map((p) => ({ target: p, data: SEL('factory()') })));
      unknownPools.forEach((p, i) => { const f = addr(r[i]); if (f) factoryOf.set(p, f); });
    }
    // One swap per venue per block, first touch of its pool in the block only.
    const seenPool = new Set<string>();
    const picks: { s: SwapLog; venue: string }[] = [];
    for (const x of list) {
      const key = x.topics[0] === T_V4 ? x.topics[1] : x.address;
      const v = venueOf(x);
      if (seenPool.has(key)) { if (wanted(v)) st(v).earlier++; continue; }
      seenPool.add(key);
      if (!wanted(v) || st(v).tested >= PER_VENUE || picks.some((p) => p.venue === v)) continue;
      picks.push({ s: x, venue: v });
    }
    if (!picks.length) continue;
    // All pre-swap state for this block in ONE request.
    const calls: { target: string; data: string }[] = [];
    const at: number[] = [];
    for (const { s: x } of picks) {
      at.push(calls.length);
      if (x.topics[0] === T_V4) calls.push(
        { target: ROBINHOOD_V4.STATE_VIEW, data: SEL('getSlot0(bytes32)') + x.topics[1].slice(2) },
        { target: ROBINHOOD_V4.STATE_VIEW, data: SEL('getLiquidity(bytes32)') + x.topics[1].slice(2) });
      else if (x.topics[0] === T_V2) calls.push({ target: x.address, data: SEL('getReserves()') }, { target: x.address, data: SEL('fee()') });
      else calls.push({ target: x.address, data: SEL('slot0()') }, { target: x.address, data: SEL('globalState()') }, { target: x.address, data: SEL('liquidity()') }, { target: x.address, data: SEL('fee()') });
    }
    let res: (string | null)[];
    try {
      const data = mc3.encodeFunctionData('aggregate3', [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
      const ret = await rpc('eth_call', [{ to: MC3, data }, ethers.toQuantity(head - 1)]);
      res = mc3.decodeFunctionResult('aggregate3', ret)[0].map((r: any) => (r.success && r.returnData !== '0x' ? r.returnData : null));
    } catch (e) { if (!firstErr) firstErr = String((e as any)?.shortMessage ?? (e as Error).message).slice(0, 160); continue; }
    picks.forEach(({ s: x, venue }, k) => {
      const i = at[k], v = st(venue);
      try {
        if (x.topics[0] === T_V2) {
          const r0 = word(res[i], 0), r1 = word(res[i], 1), feeRaw = word(res[i + 1], 0);
          if (r0 === null || r1 === null) { v.lines.push(`${x.tx.slice(0, 12)}: no reserves`); return; }
          // Known fixed fees; GIGA Classic reads fee() per pair (millionths = pips).
          const feePips = venue === 'uniswap-v2' ? 3000 : venue === 'pancakeswap-v2' ? 2500
            : feeRaw !== null && feeRaw < 100_000n ? Number(feeRaw) : 3000;
          const a0In = word(x.data, 0)!, a1In = word(x.data, 1)!, a0Out = word(x.data, 2)!, a1Out = word(x.data, 3)!;
          const zf = a0In > 0n;
          const pred = zf ? v2AmountOut(a0In, r0, r1, feePips) : v2AmountOut(a1In, r1, r0, feePips);
          const e = errorBps(pred, zf ? a1Out : a0Out);
          v.tested++; v.inBand.push(e);
          v.lines.push(`${x.tx.slice(0, 12)} v2 fee ${feePips}pips err ${e.toFixed(3)} bps`);
          return;
        }
        const v4 = x.topics[0] === T_V4;
        let sqrtP: bigint | null, liq: bigint | null, feePips: number | null;
        if (v4) {
          sqrtP = word(res[i], 0); liq = word(res[i + 1], 0);
          const lpFee = word(res[i], 3), evFee = Number(word(x.data, 5));
          if (lpFee !== null && Number(lpFee) !== evFee) { v.feeMismatch++; if (v.feeExamples.length < 12) v.feeExamples.push(`${evFee}/${lpFee}`); }
          feePips = evFee; // the fee this swap really paid (hooks may change it per swap)
        } else {
          sqrtP = word(res[i], 0) ?? word(res[i + 1], 0); liq = word(res[i + 2], 0);
          const fr = word(res[i + 3], 0);
          feePips = fr !== null ? Number(fr) : res[i + 1] ? Number(word(res[i + 1], 2)) : null;
        }
        if (!sqrtP || !liq || feePips === null) { v.lines.push(`${x.tx.slice(0, 12)}: state unreadable`); return; }
        // V3-style events: amounts from the pool's side (+ = pool received).
        // V4: from the swapper's side, so flip the sign.
        let a0 = signed(word(x.data, 0)!), a1 = signed(word(x.data, 1)!);
        if (v4) { a0 = -a0; a1 = -a1; }
        const postSqrt = word(x.data, 2)!, postLiq = word(x.data, 3)!;
        const zf = a0 > 0n;
        const { amountOut, sqrtPriceNextX96 } = clAmountOut(sqrtP, liq, zf ? a0 : a1, zf, feePips);
        const e = errorBps(amountOut, zf ? -a1 : -a0), pe = errorBps(sqrtPriceNextX96, postSqrt);
        const cross = postLiq !== liq;
        v.tested++;
        if (cross) v.crossed++; else { v.inBand.push(e); v.price.push(pe); }
        v.lines.push(`${x.tx.slice(0, 12)} fee ${feePips}pips${cross ? ' CROSSED band' : ''} out err ${e.toFixed(3)} bps, price err ${pe.toFixed(3)} bps`);
      } catch (err) { v.lines.push(`${x.tx.slice(0, 12)}: ${(err as Error).message.slice(0, 80)}`); }
    });
    if ([...stats.values()].length >= 8 && [...stats.values()].every((x) => x.tested >= PER_VENUE)) break;
  }
  const q = (xs: number[], f: number) => { const a = [...xs].sort((m, n) => m - n); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))] : NaN; };
  const summary: string[] = [firstErr ? `first state-read error: ${firstErr}` : 'state reads ok'];
  for (const [venue, v] of [...stats.entries()].sort((a, b) => b[1].tested - a[1].tested)) {
    summary.push(`${venue}: tested ${v.tested}, in-band ${v.inBand.length} (out err median ${q(v.inBand, 0.5).toFixed(3)} bps, p90 ${q(v.inBand, 0.9).toFixed(3)}, worst ${q(v.inBand, 1).toFixed(3)}; price err median ${q(v.price, 0.5).toFixed(3)}), crossed ${v.crossed}${v.feeMismatch ? `, hook fee differed from pool fee ${v.feeMismatch}x (charged/pool: ${v.feeExamples.join(' ')})` : ''}, later-in-block skips ${v.earlier}`);
  }
  note('Validation summary (our maths vs real swaps)', summary.join('\n'));
  // GitHub shows only ~10 notices per step: details for the NEW venues only.
  const isNew = (v: string) => ROBINHOOD_VENUES.some((x) => x.id === v);
  for (const [venue, v] of [...stats.entries()].filter(([k]) => isNew(k)).slice(0, 7)) if (v.lines.length) note(`Validate ${venue}`, v.lines.slice(0, 15).join('\n'));
}
main().catch((e) => { note('Venue probe failed', String(e?.message ?? e)); process.exitCode = 0; });
