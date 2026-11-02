// Read-only diagnostic: why the quick guess sees big gaps on stock-token V3/V4 pools.
// Never prints node URLs or secrets. Writes results under ~/rx/stockpx.
const R = '/home/ubuntu/multichain-arb-engine';
const OUT = '/home/ubuntu/rx/stockpx';
process.chdir(R);
require(R + '/node_modules/dotenv').config({ path: R + '/.env', quiet: true });
const { ethers } = require(R + '/node_modules/ethers');
const fs = require('fs');
const readline = require('readline');
const TM = require(OUT + '/tickMath.js');

const PAIRS = ['MRNA/USDG', 'USDG/BE', 'GOOGL/USDG', 'USDG/RIVN', 'USDG/SNDK', 'USDG/HIMS'];
const STATE_VIEW = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const V4_QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
const V3_QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const url = process.env.ROBINHOOD_RPC_HTTP || process.env.CHAINSTACK_RPC_ROBINHOOD || process.env.QUICKNODE_RPC_ROBINHOOD || 'https://rpc.mainnet.chain.robinhood.com';
const prov = new ethers.JsonRpcProvider(url, 4663, { staticNetwork: true, batchMaxCount: 1 });
const ac = ethers.AbiCoder.defaultAbiCoder();
const out = { started: new Date().toISOString(), routes: {}, pools: {} };
const save = () => fs.writeFileSync(OUT + '/diag1.json', JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 1));
const call = async (to, data, blockTag) => { try { return await prov.call({ to, data, blockTag }); } catch (e) { return 'ERR:' + String(e.shortMessage || e.message).slice(0, 120); } };

async function scanLog() {
  const f = process.env.HOME + '/.pm2/logs/dex-arb-shadow-out.log';
  const rl = readline.createInterface({ input: fs.createReadStream(f) });
  const re = /^\[sim\] robinhood (\S+) (\S+)@(0x[0-9a-f]+)->(\S+)@(0x[0-9a-f]+) (?:real: ([A-Z]+)|REAL PROFIT \$([\d.]+))([^|]*)\| model gross \$([\d.-]+) on \$(\d+)/;
  for await (const line of rl) {
    if (!line.startsWith('[sim] robinhood ')) continue;
    const m = re.exec(line); if (!m) continue;
    if (!PAIRS.includes(m[1])) continue;
    const k = `${m[1]} ${m[2]}@${m[3]}>${m[4]}@${m[5]}`;
    const r = out.routes[k] ??= { n: 0, res: {}, gross: [], size: [], why: {} };
    r.n++; const res = m[6] || 'PROFIT'; r.res[res] = (r.res[res] || 0) + 1;
    if (m[8].trim()) { const w = m[8].trim().slice(0, 60); r.why[w] = (r.why[w] || 0) + 1; }
    if (r.gross.length < 400) { r.gross.push(Number(m[9])); r.size.push(Number(m[10])); }
  }
  for (const r of Object.values(out.routes)) {
    const g = [...r.gross].sort((a, b) => a - b), s = [...r.size].sort((a, b) => a - b);
    r.grossMed = g[g.length >> 1]; r.sizeMed = s[s.length >> 1]; r.grossMax = g[g.length - 1]; delete r.gross; delete r.size;
  }
}

function botFeePips(st) {
  if (st.feePips !== undefined && st.feePips >= 0 && st.feePips < 1e6) return st.feePips;
  if (st.v4 && st.v4.fee >= 0 && st.v4.fee < 1e6) return st.v4.fee;
  return Math.round(st.feeBps * 100);
}
// The bot's current quick guess (dexMath.computeAmountOut V3 branch).
function botGuess(sqrtP, L, feePips, zeroForOne, amountIn) {
  const Q96 = 1n << 96n; const vx = (L * Q96) / sqrtP, vy = (L * sqrtP) / Q96;
  const inF = (amountIn * (1000000n - BigInt(feePips))) / 1000000n;
  return zeroForOne ? vy - (vx * vy) / (vx + inF) : vx - (vx * vy) / (vy + inF);
}

async function readPool(st, meta, B) {
  const id = st.poolAddress.toLowerCase(), isV4 = id.length === 66;
  const p = { dex: st.dex, isV4, tokenA: st.tokenA, tokenB: st.tokenB, symA: meta[st.tokenA]?.symbol ?? meta[st.tokenA.toLowerCase()]?.symbol, symB: meta[st.tokenB]?.symbol ?? meta[st.tokenB.toLowerCase()]?.symbol,
    decA_bot: (meta[st.tokenA] ?? meta[st.tokenA.toLowerCase()])?.decimals, decB_bot: (meta[st.tokenB] ?? meta[st.tokenB.toLowerCase()])?.decimals,
    bot: { sqrtP: st.sqrtPriceX96, L: st.liquidity, feeBps: st.feeBps, feePips: st.feePips, v4: st.v4, observedFee: st.observedFee, block: st.lastUpdatedBlock, variant: st.variant } };
  // decimals on chain
  for (const [k, t] of [['decA_chain', st.tokenA], ['decB_chain', st.tokenB]]) { const r = await call(t, '0x313ce567', B); p[k] = r.startsWith('0x') && r.length >= 66 ? Number(BigInt(r.slice(0, 66))) : r; }
  let ts, chainAt = {};
  const readState = async (bt) => {
    if (isV4) {
      const s0 = await call(STATE_VIEW, ethers.id('getSlot0(bytes32)').slice(0, 10) + id.slice(2), bt);
      const lq = await call(STATE_VIEW, ethers.id('getLiquidity(bytes32)').slice(0, 10) + id.slice(2), bt);
      if (!s0.startsWith('0x') || !lq.startsWith('0x')) return { err: s0 + ' ' + lq };
      const [sq, tick, pf, lpf] = ac.decode(['uint160', 'int24', 'uint24', 'uint24'], s0);
      return { sqrtP: sq, tick: Number(tick), protocolFee: Number(pf), lpFee: Number(lpf), L: ac.decode(['uint128'], lq)[0] };
    }
    const s0 = await call(id, '0x3850c7bd', bt), lq = await call(id, '0x1a686502', bt), fe = await call(id, '0xddca3f43', bt);
    if (!s0.startsWith('0x') || !lq.startsWith('0x')) return { err: s0 + ' ' + lq };
    return { sqrtP: BigInt(s0.slice(0, 66)), tick: Number(BigInt.asIntN(24, BigInt('0x' + s0.slice(66, 130)))), L: BigInt(lq.slice(0, 66)), lpFee: fe.startsWith('0x') ? Number(BigInt(fe)) : fe };
  };
  p.chainAtBotBlock = await readState(st.lastUpdatedBlock);
  p.chainNow = await readState(B);
  if (isV4) {
    ts = st.v4?.tickSpacing; p.hooks = st.v4?.hooks ?? '0x0000000000000000000000000000000000000000';
    const c0 = st.v4?.native ? ethers.ZeroAddress : st.tokenA;
    const key = [c0, st.tokenB, st.v4?.fee, ts, p.hooks];
    p.key = key; p.keyIdMatches = ethers.keccak256(ac.encode(['address', 'address', 'uint24', 'int24', 'address'], key)).toLowerCase() === id;
    const hv = Number(BigInt(p.hooks) & 0x3fffn); p.hookFlags = { beforeSwap: !!(hv & 128), afterSwap: !!(hv & 64), returnsDelta: !!(hv & 12), beforeSwapReturnsDelta: !!(hv & 8) };
  } else {
    const r = await call(id, '0xd0c93a7c', B); ts = r.startsWith('0x') ? Number(BigInt.asIntN(24, BigInt(r))) : null;
  }
  p.tickSpacing = ts;
  // tick window at B: +-4 bitmap words around the current tick
  const c = p.chainNow; if (c.err || !ts) return p;
  const w0 = TM.wordOf(c.tick, ts), ticks = [];
  for (let w = w0 - 4; w <= w0 + 4; w++) {
    const data = isV4 ? ethers.id('getTickBitmap(bytes32,int16)').slice(0, 10) + id.slice(2) + ac.encode(['int16'], [w]).slice(2) : '0x5339c296' + ac.encode(['int16'], [w]).slice(2);
    const r = await call(isV4 ? STATE_VIEW : id, data, B); if (!r.startsWith('0x')) { p.windowErr = r; return p; }
    for (const t of TM.ticksInWord(w, BigInt(r), ts)) {
      const d2 = isV4 ? ethers.id('getTickLiquidity(bytes32,int24)').slice(0, 10) + id.slice(2) + ac.encode(['int24'], [t]).slice(2) : '0xf30dba93' + ac.encode(['int24'], [t]).slice(2);
      const r2 = await call(isV4 ? STATE_VIEW : id, d2, B); if (!r2.startsWith('0x')) { p.windowErr = r2; return p; }
      ticks.push({ tick: t, liquidityNet: BigInt.asIntN(128, BigInt('0x' + r2.slice(66, 130))) });
    }
  }
  const rg = TM.wordsRange(w0 - 4, w0 + 4, ts);
  p.window = { lo: rg.lo, hi: rg.hi, ticks, block: B, ms: Date.now() };
  // nearest edges and liquidity profile around price
  const below = ticks.filter((t) => t.tick <= c.tick).slice(-3), above = ticks.filter((t) => t.tick > c.tick).slice(0, 3);
  p.edges = { below: below.map((t) => [t.tick, t.liquidityNet]), above: above.map((t) => [t.tick, t.liquidityNet]), nTicks: ticks.length,
    pctToNextDown: below.length ? (1 - 1.0001 ** (below[below.length - 1].tick - c.tick)) * 100 : null, pctToNextUp: above.length ? (1.0001 ** (above[0].tick - c.tick) - 1) * 100 : null };
  return p;
}

async function quote(p, zeroForOne, amountIn, B) {
  if (p.isV4) {
    const data = '0xaa9d21cb' + ac.encode(['tuple(tuple(address,address,uint24,int24,address),bool,uint128,bytes)'], [[p.key, zeroForOne, amountIn, '0x']]).slice(2);
    const r = await call(V4_QUOTER, data, B); return r.startsWith('0x') ? BigInt(r.slice(0, 66)) : r;
  }
  if (p.dex !== 'uniswap-v3') return 'n/a';
  const [tin, tout] = zeroForOne ? [p.tokenA, p.tokenB] : [p.tokenB, p.tokenA];
  const data = '0xc6a5026a' + ac.encode(['tuple(address,address,uint256,uint24,uint160)'], [[tin, tout, amountIn, p.chainNow.lpFee, 0n]]).slice(2);
  const r = await call(V3_QUOTER, data, B); return r.startsWith('0x') ? BigInt(r.slice(0, 66)) : r;
}

(async () => {
  // V4 quoter selector check (quoteExactInputSingle((( ...),bool,uint128,bytes)))
  out.v4QuoterSel = ethers.id('quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))').slice(0, 10);
  out.v3QuoterSel = ethers.id('quoteExactInputSingle((address,address,uint256,uint24,uint160))').slice(0, 10);
  await scanLog(); save();
  const W = JSON.parse(fs.readFileSync('data/watched-pools.json', 'utf8'), (_k, v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? BigInt(v.$b) : v));
  out.watchSavedAt = new Date(W.savedAt).toISOString();
  const meta = W.meta || {};
  const B = await prov.getBlockNumber(); out.block = B;
  const byPfx = (pfx) => W.pools.filter((s) => s.poolAddress.toLowerCase().startsWith(pfx));
  // top routes by count
  const routes = Object.entries(out.routes).sort((a, b) => b[1].n - a[1].n);
  const seen = new Set(); const todo = [];
  for (const [k] of routes) {
    const m = /^(\S+) (\S+)@(0x[0-9a-f]+)>(\S+)@(0x[0-9a-f]+)$/.exec(k);
    for (const pfx of [m[3], m[5]]) if (!seen.has(pfx)) { seen.add(pfx); todo.push(pfx); }
  }
  for (const pfx of todo.slice(0, 24)) {
    const sts = byPfx(pfx); if (sts.length !== 1) { out.pools[pfx] = { err: `found ${sts.length} in watch file` }; continue; }
    try { out.pools[pfx] = await readPool(sts[0], meta, B); } catch (e) { out.pools[pfx] = { err: String(e.message).slice(0, 200) }; }
    save();
  }
  // Single-pool comparisons: bot guess vs tick walk vs quoter, USDG in and coin in.
  for (const [pfx, p] of Object.entries(out.pools)) {
    if (p.err || !p.chainNow || p.chainNow.err) continue;
    const c = p.chainNow; const usdgIsA = p.tokenA.toLowerCase() === USDG; if (!usdgIsA && p.tokenB.toLowerCase() !== USDG) continue;
    const decU = usdgIsA ? p.decA_chain : p.decB_chain, decS = usdgIsA ? p.decB_chain : p.decA_chain;
    // price of coin in USDG from sqrtP
    const r = (Number(c.sqrtP) / 2 ** 96) ** 2 * 10 ** (p.decA_chain - p.decB_chain); // tokenB per tokenA
    const coinUsd = usdgIsA ? 1 / r : r; p.coinUsd = coinUsd;
    const feeChain = c.lpFee; const feeBot = botFeePips({ ...p.bot, v4: p.bot.v4, feeBps: p.bot.feeBps });
    p.feeBot = feeBot; p.feeChain = feeChain;
    p.cmp = [];
    for (const usd of [50, 200, 500, 1100, 3000]) {
      for (const usdgIn of [true, false]) {
        const zeroForOne = usdgIn ? usdgIsA : !usdgIsA;
        const amt = usdgIn ? BigInt(Math.round(usd * 10 ** decU)) : BigInt(Math.round((usd / coinUsd) * 10 ** Math.min(decS, 15))) * 10n ** BigInt(Math.max(0, decS - 15));
        const g = botGuess(c.sqrtP, c.L, feeBot, zeroForOne, amt);
        const tw = p.window ? TM.swapExactInTicks({ sqrtPriceX96: c.sqrtP, liquidity: c.L, tick: c.tick, feePips: Number(feeChain), window: p.window, zeroForOne, amountIn: amt }) : null;
        const q = await quote(p, zeroForOne, amt, B);
        const dOut = usdgIn ? decS : decU; const toUsd = (x) => typeof x === 'bigint' ? Number(x) / 10 ** dOut * (usdgIn ? coinUsd : 1) : x;
        p.cmp.push({ usd, in: usdgIn ? 'USDG' : 'coin', guessUsd: toUsd(g), tickUsd: tw ? toUsd(tw.amountOut) : null, crossed: tw?.crossed, left: tw?.leftWindow, quoterUsd: toUsd(q),
          exactMatch: typeof q === 'bigint' && tw ? (q === tw.amountOut) : null });
      }
    }
    save();
  }
  out.done = new Date().toISOString(); save();
})().catch((e) => { out.fatal = String(e.message).slice(0, 300); save(); });
