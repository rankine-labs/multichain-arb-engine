// ============================================================================
// RIVAL REPLAY PROBE (research, read-only) -- reconstructs real competitor
// arbitrage transactions on Robinhood Chain from on-chain receipts.
//
// For recent blocks it reads every receipt and keeps trades that:
//   - swapped through 2+ pools, and
//   - left the trading contract + sender (together, "E") with no coin LESS
//     than before and MORE of only WETH and/or USDG (values we can price
//     reliably), after subtracting the gas the sender paid.
// That is "independently verifiable positive net profit".
//
// For each such trade: pools (DEX via factory(), fee tier, coins), route
// order, amount put in, profit, gas, funding (flash loan event, flash swap,
// or own money), the trigger (the closest earlier trade in the same block
// that touched one of its pools) and each pool's depth.
// Also: route-length / funding stats over ALL arbitrage-shaped trades, and a
// dump of trades by the contract starting 0x591d69 (the "ORBIO" outlier).
//
// Nothing is sent; only eth_* reads on the public node, paced slowly.
// ============================================================================
import { ethers } from 'ethers';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const UNI_V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const FACTORIES: Record<string, string> = {
  '0x1f7d7550b1b028f7571e69a784071f0205fd2efa': 'uniswap-v3',
  '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865': 'pancakeswap-v3',
  '0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8': 'ramses-v3',
  '0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e': 'pancakeswap-v2',
  '0x43b2bf9f33036a02fc7a00935571c2a6b0108e66': 'ramses-v2',
};
const MAX_BLOCKS = Number(process.env.PROBE_BLOCKS ?? 3000);
const WANT = Number(process.env.PROBE_WANT ?? 20);
const PACE_MS = Number(process.env.PROBE_PACE_MS ?? 650);

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const DEPOSIT = ethers.id('Deposit(address,uint256)');
const WITHDRAWAL = ethers.id('Withdrawal(address,uint256)');
const V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const SWAPS = new Set([
  ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'),
  V4_SWAP,
]);
const FLASH = new Set([
  ethers.id('Flash(address,address,uint256,uint256,uint256,uint256)'),
  ethers.id('FlashLoan(address,address,address,uint256,uint8,uint256,uint16)'),
  ethers.id('FlashLoan(address,address,uint256,uint256)'),
]);
const ta = (t: string) => '0x' + t.slice(26).toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let id = 0, blocked = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      if (res.status === 403 || res.status === 429) { blocked++; await sleep(15_000 * (i + 1)); continue; }
      const j = await res.json();
      if (j.error && /429|Too Many|rate/i.test(JSON.stringify(j.error))) { await sleep(3_000 * (i + 1)); continue; }
      return j;
    } catch { await sleep(2_000); }
  }
  return { error: { message: 'gave up' } };
}
const call = async (to: string, data: string, tag = 'latest') => (await rpc('eth_call', [{ to, data }, tag])).result as string | undefined;
const word = (r: string | undefined, i = 0) => (r && r.length >= 2 + 64 * (i + 1) ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null);
const addrOf = (r: string | undefined) => (r && r.length >= 66 ? '0x' + r.slice(26, 66).toLowerCase() : null);
const symCache = new Map<string, string>();
async function symbol(t: string): Promise<string> {
  if (symCache.has(t)) return symCache.get(t)!;
  const r = await call(t, '0x95d89b41');
  let s = '?';
  try {
    if (r && r.length >= 194) { const len = Number(BigInt('0x' + r.slice(66, 130))); s = Buffer.from(r.slice(130, 130 + len * 2), 'hex').toString('utf8'); }
    else if (r && r.length >= 66) s = Buffer.from(r.slice(2, 66), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { /* keep ? */ }
  s = s.replace(/[^\x20-\x7e]/g, '').slice(0, 12) || t.slice(0, 8);
  symCache.set(t, s);
  return s;
}

interface Arb { hash: string; block: number; index: number; from: string; to: string; pools: string[]; deltas: Map<string, bigint>; flash: boolean; gasWei: bigint; logs: any[] }

// Coin balance changes of the trading contract + sender (E) in one receipt.
function deltasFor(logs: any[], E: Set<string>): Map<string, bigint> {
  const d = new Map<string, bigint>();
  const add = (tok: string, v: bigint) => d.set(tok, (d.get(tok) ?? 0n) + v);
  for (const l of logs) {
    const t0 = l.topics?.[0];
    const tok = String(l.address).toLowerCase();
    let v: bigint; try { v = BigInt(l.data === '0x' ? 0 : l.data.slice(0, 66)); } catch { continue; }
    if (t0 === TRANSFER && l.topics.length >= 3) {
      const f = ta(l.topics[1]), t = ta(l.topics[2]);
      if (E.has(f) && E.has(t)) continue; // internal move between bot and its owner
      if (E.has(t)) add(tok, v);
      if (E.has(f)) add(tok, -v);
    } else if (tok === WETH && (t0 === DEPOSIT || t0 === WITHDRAWAL) && l.topics.length >= 2) {
      // WETH wrap/unwrap moves value between native ETH and WETH; native ETH
      // isn't visible in logs, so treat as neutral (skip) but flag it.
      if (E.has(ta(l.topics[1]))) add('native-eth-wrap', t0 === DEPOSIT ? 1n : -1n);
    }
  }
  return d;
}

(async () => {
  // WETH price from the deepest Uniswap V3 WETH/USDG pool (0.05%).
  const pool05 = addrOf(await call(UNI_V3_FACTORY, '0x1698ee82' + WETH.slice(2).padStart(64, '0') + USDG.slice(2).padStart(64, '0') + (500).toString(16).padStart(64, '0')));
  const slot0 = await call(pool05!, '0x3850c7bd');
  const sqrt = Number(word(slot0, 0)!) / 2 ** 96;
  const ethUsd = sqrt * sqrt * 1e12; // token0 = WETH (18), token1 = USDG (6)
  const usd = (tok: string, v: bigint) => (tok === WETH ? (Number(v) / 1e18) * ethUsd : tok === USDG ? Number(v) / 1e6 : null);
  console.log(`ETH price used: $${ethUsd.toFixed(2)} (from ${pool05})`);

  const latest = Number((await rpc('eth_blockNumber', [])).result);
  const verified: (Arb & { netUsd: number; grossUsd: number; gasUsd: number; sizeUsd: number; trigger: { hash: string; index: number } | null; blockTs: number })[] = [];
  const shape = { arbs: 0, two: 0, three: 0, fourPlus: 0, flash: 0, positiveKnown: 0 };
  const orbio: string[] = [];
  let blocksRead = 0, receipts = 0, firstTs = 0, lastTs = 0;

  for (let n = latest - 3; n > latest - 3 - MAX_BLOCKS && verified.length < WANT; n--) {
    const r = await rpc('eth_getBlockReceipts', ['0x' + n.toString(16)]);
    await sleep(PACE_MS);
    const rcpts: any[] = r.result ?? [];
    if (!Array.isArray(rcpts) || !rcpts.length) continue;
    blocksRead++; receipts += rcpts.length;
    for (const rc of rcpts) {
      if (rc.status !== '0x1' || !rc.to) continue;
      const pools: string[] = [];
      for (const l of rc.logs ?? []) {
        const t0 = l.topics?.[0];
        if (SWAPS.has(t0)) { const p = t0 === V4_SWAP ? l.topics[1].toLowerCase() : String(l.address).toLowerCase(); if (!pools.includes(p)) pools.push(p); }
      }
      if (pools.length < 2) continue;
      const E = new Set([String(rc.to).toLowerCase(), String(rc.from).toLowerCase()]);
      const d = deltasFor(rc.logs, E);
      const moves = [...d.entries()].filter(([k, v]) => v !== 0n && k !== 'native-eth-wrap');
      if (!moves.length || moves.some(([, v]) => v < 0n)) continue; // not "ends with more, less of nothing"
      const flash = (rc.logs ?? []).some((l: any) => FLASH.has(l.topics?.[0]));
      shape.arbs++;
      if (pools.length === 2) shape.two++; else if (pools.length === 3) shape.three++; else shape.fourPlus++;
      if (flash) shape.flash++;
      const to = String(rc.to).toLowerCase();
      if (to.startsWith('0x591d69') && orbio.length < 4) {
        const parts = [];
        for (const [k, v] of moves) parts.push(`${await symbol(k)}(${k.slice(0, 10)}) +${v}`);
        orbio.push(`${rc.transactionHash} pools ${pools.length} gains: ${parts.join(', ')}`);
      }
      // Verifiable: only WETH/USDG gained.
      if (!moves.every(([k]) => k === WETH || k === USDG)) continue;
      shape.positiveKnown++;
      const grossUsd = moves.reduce((s, [k, v]) => s + (usd(k, v) ?? 0), 0);
      const gasWei = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? '0x0');
      const gasUsd = (Number(gasWei) / 1e18) * ethUsd;
      if (grossUsd - gasUsd <= 0) continue;
      // Trade size: biggest WETH/USDG amount E sent out.
      let sizeUsd = 0;
      for (const l of rc.logs) if (l.topics?.[0] === TRANSFER && l.topics.length >= 3 && E.has(ta(l.topics[1])) && !E.has(ta(l.topics[2]))) {
        const u = usd(String(l.address).toLowerCase(), BigInt(l.data.slice(0, 66))); if (u !== null) sizeUsd = Math.max(sizeUsd, u);
      }
      // Trigger: closest earlier trade in this block touching one of its pools, by someone else.
      const idx = Number(rc.transactionIndex);
      let trigger: { hash: string; index: number } | null = null;
      for (const o of rcpts) {
        const oi = Number(o.transactionIndex);
        if (oi >= idx || E.has(String(o.from).toLowerCase())) continue;
        if ((o.logs ?? []).some((l: any) => SWAPS.has(l.topics?.[0]) && pools.includes(l.topics[0] === V4_SWAP ? l.topics[1].toLowerCase() : String(l.address).toLowerCase())))
          if (!trigger || oi > trigger.index) trigger = { hash: o.transactionHash, index: oi };
      }
      verified.push({ hash: rc.transactionHash, block: n, index: idx, from: rc.from, to, pools, deltas: d, flash, gasWei, logs: rc.logs, netUsd: grossUsd - gasUsd, grossUsd, gasUsd, sizeUsd, trigger, blockTs: 0 });
    }
    if (blocksRead === 1 || verified.length >= WANT || n % 200 === 0) {
      const b = (await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false])).result;
      const ts = Number(b?.timestamp ?? 0);
      if (!lastTs) lastTs = ts; firstTs = ts;
    }
  }

  // Details for the verified trades.
  const lines: string[] = [];
  for (const v of verified) {
    const poolInfo: string[] = [];
    for (const p of v.pools) {
      if (p.length === 66) { poolInfo.push(`V4:${p.slice(0, 10)}`); continue; }
      const [t0, t1, fac, fee] = [await call(p, '0x0dfe1681'), await call(p, '0xd21220a7'), await call(p, '0xc45a0155'), await call(p, '0xddca3f43')];
      const a = addrOf(t0), b = addrOf(t1);
      const dex = FACTORIES[addrOf(fac) ?? ''] ?? `other(${(addrOf(fac) ?? '?').slice(0, 8)})`;
      const feeP = word(fee) !== null && dex.endsWith('v3') ? `${Number(word(fee)) / 10_000}%` : '';
      // Depth: WETH/USDG side x2 when present.
      let depth = '?';
      for (const tok of [a, b]) if (tok === WETH || tok === USDG) {
        const bal = word(await call(tok, '0x70a08231' + p.slice(2).padStart(64, '0')));
        if (bal !== null) depth = `$${Math.round(2 * (usd(tok, bal) ?? 0)).toLocaleString('en-US')}`;
      }
      poolInfo.push(`${dex}${feeP ? ' ' + feeP : ''} ${a ? await symbol(a) : '?'}/${b ? await symbol(b) : '?'} ${p.slice(0, 10)} depth ${depth}`);
    }
    // Funding: flash event, or flash swap (a pool paid E before E paid anything), else own money.
    let funding = v.flash ? 'flash loan' : 'own money';
    if (!v.flash) {
      const E = new Set([v.to, v.from.toLowerCase()]);
      const firstIn = v.logs.findIndex((l: any) => l.topics?.[0] === TRANSFER && l.topics.length >= 3 && E.has(ta(l.topics[2])));
      const firstOut = v.logs.findIndex((l: any) => l.topics?.[0] === TRANSFER && l.topics.length >= 3 && E.has(ta(l.topics[1])));
      if (firstIn >= 0 && (firstOut < 0 || firstIn < firstOut)) funding = 'flash swap (pool paid first)';
    }
    const gain = [...v.deltas.entries()].filter(([k, x]) => x > 0n && k !== 'native-eth-wrap').map(([k, x]) => `${k === WETH ? 'WETH' : 'USDG'} +${k === WETH ? (Number(x) / 1e18).toFixed(6) : (Number(x) / 1e6).toFixed(4)}`).join(' ');
    lines.push(`${v.hash} | blk ${v.block} idx ${v.index} | bot ${v.to.slice(0, 10)} | ${v.pools.length} pools | in $${v.sizeUsd.toFixed(2)} | gross $${v.grossUsd.toFixed(4)} gas $${v.gasUsd.toFixed(4)} NET $${v.netUsd.toFixed(4)} | ${gain} | ${funding} | trigger ${v.trigger ? `${v.trigger.hash.slice(0, 12)} idx ${v.trigger.index} (gap ${v.index - v.trigger.index})` : 'none in block'} | ${poolInfo.join(' -> ')}`);
  }
  const secs = lastTs && firstTs ? lastTs - firstTs : 0;
  const summary = [
    `Read ${blocksRead} blocks (${receipts} txs, about ${Math.round(secs / 60)} min of chain time). Node blocks/limits hit: ${blocked}.`,
    `Arbitrage-shaped trades (2+ pools, ended with more and less of nothing): ${shape.arbs}. Routes: 2 pools ${shape.two}, 3 pools ${shape.three}, 4+ ${shape.fourPlus}. Flash loans: ${shape.flash}. Gains only in WETH/USDG: ${shape.positiveKnown}.`,
    `Verified positive net after gas: ${verified.length}. Total net $${verified.reduce((s, v) => s + v.netUsd, 0).toFixed(4)}, median net $${(verified.map((v) => v.netUsd).sort((a, b) => a - b)[Math.floor(verified.length / 2)] ?? 0).toFixed(4)}.`,
    `0x591d69 (ORBIO) trades seen: ${orbio.length}`,
  ];
  console.log(summary.join('\n'));
  for (const l of lines) console.log(l);
  for (const o of orbio) console.log('ORBIO: ' + o);
  // GitHub annotations: summary + 3 trades per notice (max 10 notices per step).
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
  console.log(`::notice title=Replay summary::${esc(summary.join('\n') + (orbio.length ? '\n' + orbio.join('\n') : ''))}`);
  for (let i = 0; i < lines.length && i < 24; i += 3) console.log(`::notice title=Replay trades ${i + 1}-${Math.min(i + 3, lines.length)}::${esc(lines.slice(i, i + 3).join('\n'))}`);
})();
