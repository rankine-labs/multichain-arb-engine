// ============================================================================
// PROFIT MEASURE - V4 fix-up pass (read-only).
//
// Plain English:
//   The main run could not name most Uniswap V4 pools (which two coins, which
//   fee), so trades through them could not be checked properly: a plain-ETH
//   payment into such a pool leaves no coin-transfer record and can make a
//   normal swap look like profit. This pass:
//     1. takes every arbitrage from results/profit-measure/arbs.jsonl that
//        went through an unnamed V4 pool,
//     2. reads its receipt again and, for each unnamed pool, takes the fee
//        from the pool's Swap event and the candidate coins from the coin
//        transfers into/out of the V4 PoolManager in that same transaction,
//     3. solves for the pool key (pool id = hash of coin0, coin1, fee, tick
//        spacing, hooks=0), and also tries the pool-creation (Initialize)
//        event search in chunks for the ones still unnamed (hooked pools),
//     4. re-runs the bot's arbitrage check on those receipts with the new
//        pool knowledge and writes results/profit-measure/v4fix/*.
//   Sends nothing, signs nothing, never touches the bot server.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { classifyTx, decodeSwapLog, receiptGasWei, V4_INITIALIZE, ZERO_ADDR, ArbRecord } from '../../src/core/followMoney';
import { ROBINHOOD_V4, ROBINHOOD_TOKENS } from '../../src/config/knownAddresses';
import { V4_LOOKUP_TIERS } from '../../src/config/v4Tiers';

const RPC_URL = process.env.PM_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const DIR = 'results/profit-measure';
const OUT = `${DIR}/v4fix`;
const PM = ROBINHOOD_V4.POOL_MANAGER.toLowerCase();
const WETH = ROBINHOOD_TOKENS.WETH.toLowerCase();
const USDG = ROBINHOOD_TOKENS.USDG.toLowerCase();
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BATCH = Number(process.env.PM_BATCH ?? 25);
const INIT_MIN = Number(process.env.PM_INIT_MIN ?? 25);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => '0x' + n.toString(16);
const lc = (s: string) => String(s ?? '').toLowerCase();
const T0 = Date.now();
const log = (m: string) => console.log(`[v4fix ${((Date.now() - T0) / 60000).toFixed(1)}m] ${m}`);

// --- polite RPC (same idea as measure.ts: spaced requests, slow down on 429)
let rps = 3, next = 0, http = 0, limited = 0;
async function post(body: unknown, timeout = 60_000): Promise<any> {
  const now = Date.now(); const at = Math.max(now, next); next = at + 1000 / rps; if (at > now) await sleep(at - now);
  http++;
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const t = await r.text();
  if (r.status === 429) { limited++; rps = Math.max(0.7, rps * 0.7); next = Date.now() + 2000; throw new Error('429'); }
  const j = JSON.parse(t);
  if (!Array.isArray(j) && j?.error?.code === 429) { limited++; rps = Math.max(0.7, rps * 0.7); next = Date.now() + 2000; throw new Error('429'); }
  return j;
}
setInterval(() => { rps = Math.min(4, rps + 0.3); }, 30_000).unref();
async function receipts(hashes: string[]): Promise<any[]> {
  const out: any[] = new Array(hashes.length).fill(null);
  for (let i = 0; i < hashes.length; i += BATCH) {
    const part = hashes.slice(i, i + BATCH);
    for (let a = 0; a < 8; a++) {
      try {
        const j = await post(part.map((h, k) => ({ jsonrpc: '2.0', id: k + 1, method: 'eth_getTransactionReceipt', params: [h] })));
        if (!Array.isArray(j)) throw new Error('not batch');
        let missing = 0;
        for (const r of j) { const k = Number(r.id) - 1; if (r.result) out[i + k] = r.result; else missing++; }
        if (missing && a < 7) { await sleep(1500); const still = part.map((_, k) => i + k).filter((x) => !out[x]); if (still.length) { continue; } }
        break;
      } catch { await sleep(Math.min(20_000, 1000 * 2 ** a)); }
    }
    if (i % (BATCH * 40) === 0) log(`receipts ${i}/${hashes.length} (rps ${rps.toFixed(1)}, 429s ${limited})`);
  }
  return out;
}

// --- pool id = keccak(abi.encode(c0, c1, fee, tickSpacing, hooks))
const buf = new Uint8Array(160);
function putAddr(off: number, a: string) { buf.fill(0, off, off + 32); for (let i = 0; i < 20; i++) buf[off + 12 + i] = parseInt(a.slice(2 + 2 * i, 4 + 2 * i), 16); }
function putUint(off: number, v: number) { buf.fill(0, off, off + 32); let x = v; for (let i = 31; i >= 28 && x > 0; i--) { buf[off + i] = x & 255; x = Math.floor(x / 256); } }
const toHex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
const TICKS: number[] = [];
for (let t = 1; t <= 200; t++) TICKS.push(t);
for (let t = 210; t <= 2000; t += 10) TICKS.push(t);
for (const t of [16383, 32767]) TICKS.push(t);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const meta = JSON.parse(readFileSync(`${DIR}/meta.json`, 'utf8'));
  const arbs: (ArbRecord & { tier: number })[] = readFileSync(`${DIR}/arbs.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const known = new Map<string, { t0: string; t1: string; dex: string; hooks: string }>();
  for (const [p, i] of Object.entries<any>(meta.poolInfo)) if (i && p.length === 66) known.set(p, i);
  const todo = arbs.filter((a) => a.uncertain.includes('v4-pool-unknown'));
  log(`arbitrage through unnamed V4 pools: ${todo.length}`);

  // 1. Receipts again.
  const rs = await receipts(todo.map((a) => a.hash));
  log(`receipts read: ${rs.filter(Boolean).length}/${todo.length}`);

  // 2. Per unnamed pool: fees seen and candidate coins.
  const cand = new Map<string, { fees: Set<number>; coins: Set<string> }>();
  rs.forEach((r) => {
    if (!r?.logs) return;
    const pmCoins = new Set<string>([ZERO_ADDR, WETH, USDG]);
    for (const l of r.logs) if (l.topics?.[0] === TRANSFER && l.topics.length >= 3) {
      const from = '0x' + l.topics[1].slice(26), to = '0x' + l.topics[2].slice(26);
      if (lc(from) === PM || lc(to) === PM) pmCoins.add(lc(l.address));
    }
    for (const l of r.logs) {
      const s = decodeSwapLog(l);
      if (!s || s.kind !== 'v4' || known.has(s.pool)) continue;
      const fee = parseInt((l.data as string).slice(2 + 64 * 5, 2 + 64 * 6), 16);  // Swap(...,uint24 fee) = word 5 of data
      const e = cand.get(s.pool) ?? { fees: new Set(), coins: new Set() };
      e.fees.add(fee); for (const c of pmCoins) e.coins.add(c);
      cand.set(s.pool, e);
    }
  });
  log(`unnamed V4 pools in these trades: ${cand.size}`);

  // 3b. Pool-creation events for the rest (hooked pools), chunked search.
  const rest = [...cand.keys()].filter((id) => !known.has(id));
  // Busiest pools first (most trades through them).
  const uses = new Map<string, number>(); rs.forEach((r) => { for (const l of r?.logs ?? []) { const s2 = decodeSwapLog(l); if (s2?.kind === 'v4' && cand.has(s2.pool)) uses.set(s2.pool, (uses.get(s2.pool) ?? 0) + 1); } });
  rest.sort((x, y) => (uses.get(y) ?? 0) - (uses.get(x) ?? 0));
  let head = 0;
  for (let a = 0; a < 10 && !head; a++) { try { head = parseInt((await post({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })).result, 16) || 0; } catch { await sleep(3000); } }
  const initErrors: Record<string, number> = {};
  const deadline = Date.now() + INIT_MIN * 60_000;
  let viaInit = 0, initCalls = 0;
  let firstOk: string | null = null;
  // The public node allows at most 100,000 blocks per log query, so walk
  // the whole history newest-first in 100k-block chunks, many ids per query.
  let GROUP = Number(process.env.PM_INIT_GROUP ?? 800);
  const CH = 100_000;
  for (let i = 0; i < rest.length && Date.now() < deadline;) {
    const ids = rest.slice(i, i + GROUP).filter((id) => !known.has(id));
    if (!ids.length) { i += GROUP; continue; }
    let refused = false;
    for (let t = head; t >= 0 && Date.now() < deadline; t -= CH) {
      const f = Math.max(0, t - CH + 1);
      let j: any = null;
      for (let a = 0; a < 6 && !j; a++) {
        try { initCalls++; j = await post({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: ROBINHOOD_V4.POOL_MANAGER, fromBlock: hex(f), toBlock: hex(t), topics: [V4_INITIALIZE, ids] }] }, 90_000); }
        catch (e: any) { const m = String(e?.message ?? e).slice(0, 60); initErrors[m] = (initErrors[m] ?? 0) + 1; await sleep(2000); }
      }
      if (!j) continue;
      if (j.error) {
        const m = String(j.error.message ?? '').slice(0, 80); initErrors[m] = (initErrors[m] ?? 0) + 1;
        if (GROUP > 50 && /topic|too many|limit|size|large/i.test(m)) { GROUP = Math.floor(GROUP / 2); refused = true; break; }
        continue;
      }
      if (!firstOk) firstOk = `range ${f}-${t} ok, ${(j.result ?? []).length} logs, group ${ids.length}`;
      for (const l of j.result ?? []) {
        const id = lc(l.topics[1]);
        const d = (l.data as string).slice(2);
        const fee = parseInt(d.slice(0, 64), 16), ts = Number(BigInt.asIntN(24, BigInt('0x' + d.slice(64, 128))));
        const hooks = '0x' + d.slice(128 + 24, 192);
        if (!known.has(id)) { known.set(id, { t0: '0x' + l.topics[2].slice(26), t1: '0x' + l.topics[3].slice(26), fee, tickSpacing: ts, hooks: lc(hooks), dex: lc(hooks) === ZERO_ADDR ? 'uniswap-v4' : 'uniswap-v4-hooked', how: 'initialize' } as any); viaInit++; }
      }
      if (ids.every((id) => known.has(id))) break;
      if ((head - t) % (CH * 100) === 0) log(`Initialize search: ids ${i}-${i + ids.length}, down to block ${f}, named ${viaInit}, rps ${rps.toFixed(1)}`);
    }
    if (!refused) i += GROUP;
  }
  log(`named via Initialize search: ${viaInit} (${initCalls} calls); errors: ${JSON.stringify(initErrors).slice(0, 400)}; first ok: ${firstOk}`);
  writeFileSync(`${OUT}/v4keys-init.json`, JSON.stringify(Object.fromEntries([...known].filter(([id]) => cand.has(id)))));

  // 3a. Solve for hooks = 0 keys.
  const extraTiers = V4_LOOKUP_TIERS.map(([f, t]) => [f, t] as [number, number]);
  let solved = 0;
  for (const [id, e] of cand) {
    if (known.has(id)) continue;
    const coins = [...e.coins].slice(0, 10).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const fees = [...e.fees];
    let hit: any = null;
    for (let i = 0; i < coins.length && !hit; i++) for (let j = i + 1; j < coins.length && !hit; j++) {
      putAddr(0, coins[i]); putAddr(32, coins[j]); putAddr(128, ZERO_ADDR);
      const tries: [number, number][] = [];
      for (const f of fees) { for (let t = 1; t <= 200; t++) tries.push([f, t]); for (const t of [f / 100, f / 50, f / 200, f / 20].filter((x) => Number.isInteger(x) && x > 200)) tries.push([f, t]); }
      for (const x of extraTiers) tries.push(x);
      for (const [f, t] of tries) {
        putUint(64, f); putUint(96, t);
        if (toHex(keccak_256(buf)) === id) { hit = { t0: coins[i], t1: coins[j], fee: f, tickSpacing: t, hooks: ZERO_ADDR, dex: 'uniswap-v4', how: 'id-solve' }; break; }
      }
    }
    if (hit) { known.set(id, hit); solved++; }
  }
  log(`solved by id (no hooks): ${solved}/${cand.size}`);
  const solvedIds = solved;

  // 4. Re-check those trades with the new knowledge.
  const v4Currencies = (id: string) => { const i = known.get(id); return i ? { c0: i.t0, c1: i.t1 } : null; };
  const fixed: any[] = [];
  let still = 0, dropped = 0, kept = 0;
  todo.forEach((a, k) => {
    const r = rs[k]; if (!r?.logs) { fixed.push({ hash: a.hash, status: 'no-receipt' }); return; }
    const out = classifyTx(r.logs, r.from, r.to, r.status, { hash: a.hash, block: a.block, txIndex: a.txIndex, ...receiptGasWei(r) }, { poolManager: PM, weth: WETH, v4Currencies });
    if (!out.arb) { dropped++; fixed.push({ hash: a.hash, status: 'not-arb', reason: out.reason }); return; }
    if (out.arb.uncertain.includes('v4-pool-unknown')) still++; else kept++;
    fixed.push({ hash: a.hash, status: 'arb', arb: { ...out.arb, tier: a.tier } });
  });
  log(`re-check: ${kept} arbitrage fully named, ${still} still through an unnamed pool, ${dropped} were NOT arbitrage`);
  const keysOut: Record<string, any> = {};
  for (const [id, i] of known) if (cand.has(id)) keysOut[id] = i;
  writeFileSync(`${OUT}/v4keys.json`, JSON.stringify(keysOut));
  writeFileSync(`${OUT}/arbs-fixed.jsonl`, fixed.map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(`${OUT}/stats.json`, JSON.stringify({ todo: todo.length, unnamedPools: cand.size, solved, viaInit, initCalls, firstOk, initErrors, kept, still, dropped, http, limited, minutes: (Date.now() - T0) / 60000 }, null, 1));
  log('saved');
}
main().then(() => process.exit(0)).catch((e) => { console.error('[v4fix] stopped:', String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<node>')); process.exit(1); });
