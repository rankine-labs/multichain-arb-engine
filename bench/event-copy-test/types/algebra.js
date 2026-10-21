// ============================================================================
// POOL TYPE 4: Algebra Integral (used by Alandale / KittenSwap)
//   real AlgebraPool + AlgebraFactory + AlgebraPoolDeployer bytecode from npm
//   @cryptoalgebra/integral-core 1.2.10, and the standard "base plugin"
//   (dynamic fee + price history "timepoints") from
//   @cryptoalgebra/integral-base-plugin 1.2.4. Community fee 10% to a vault.
//
// Pool storage (slot: what):
//   0/1 totalFeeGrowth0/1      2 globalState = price|tick|lastFee|pluginConfig|communityFee|unlocked
//   3 ticks[tick] (4 slots: liquidityTotal, liquidityDelta|prevTick|nextTick,
//                  outerFeeGrowth0, outerFeeGrowth1)
//   4 communityFeePending0|1|lastFeeTransferTimestamp   5 pluginFeePending0|1
//   6 plugin   7 communityVault   8 tickTable[word] (tick search tree, leaves)
//   9 nextTickGlobal|prevTickGlobal|liquidity|tickSpacing|tickTreeRoot
//     (tickTreeRoot, declared in TickStructure, packs into the same slot)
//   10 tickTreeSecondLayer[word]   11 positions[key] (4 slots)
//   12 reserve0|reserve1
//   (confirmed on anvil: a first run with tickTreeRoot in its own slot made
//    the copy's state differ from the truth in exactly these slots)
// The PLUGIN is a separate contract with its own storage (fee settings,
// timepoints = price history used to compute the dynamic fee). The pool asks
// the plugin for the fee at the start of EVERY swap, including our check.
//
// Copy variants:
//  "fields": write only what events say.
//     Swap        -> globalState price+tick, liquidity; prev/nextTickGlobal
//                    computed from our own list of active ticks.
//     reserves    -> +amounts of Swap/Mint, -amounts of Collect, +ExcessTokens,
//                    -fee Transfers from the pool to the vault.
//     Fee / PluginConfig / CommunityFee events -> their globalState field.
//     NOT derivable: totalFeeGrowth0/1, ticks' outerFeeGrowth, the pending
//                    community/plugin fees (+ last fee transfer time, same
//                    slot) and ALL plugin storage (timepoints, volatility).
//     Mint/Burn/Collect/Flash -> counted node re-read of the slots they touch.
//  "replay": re-do every pool event with the pool's own code on the copy
//     (the pool also calls the plugin, so plugin storage follows exactly).
//  "fields-plugin": like "fields", but before each Swap's fields are written,
//     the PLUGIN's own beforeSwap hook is run on the copy (as if called by the
//     pool, with the copy's pre-swap pool state). Still events-only: the hook
//     only needs the pool's tick and the block time. Shows whether the pool's
//     stale fee counters matter once the plugin is right.
// ============================================================================
const L = require('../lib');
const C = require('./common');
const { ethers, abi, hex32, lc } = L;

const R = (p) => require('@cryptoalgebra/' + p);
const fA = R('integral-core/artifacts/contracts/AlgebraFactory.sol/AlgebraFactory.json');
const dA = R('integral-core/artifacts/contracts/AlgebraPoolDeployer.sol/AlgebraPoolDeployer.json');
const pA = R('integral-core/artifacts/contracts/AlgebraPool.sol/AlgebraPool.json');
const vA = R('integral-core/artifacts/contracts/AlgebraVaultFactoryStub.sol/AlgebraVaultFactoryStub.json');
const pfA = R('integral-base-plugin/artifacts/contracts/BasePluginV1Factory.sol/BasePluginV1Factory.json');
const plA = R('integral-base-plugin/artifacts/contracts/AlgebraBasePluginV1.sol/AlgebraBasePluginV1.json');
const pluginIface = new ethers.Interface(plA.abi);

const poolIface = new ethers.Interface(pA.abi);
const traderIface = () => new ethers.Interface(L.helpers().Trader.abi);
const replayerIface = () => new ethers.Interface(L.helpers().Replayer.abi);
const REPLAYER = '0x00000000000000000000000000000000fee0beef';
const VAULT = '0x00000000000000000000000000000000000ca11e';
const SPACING = 60;
const MIN_TICK = -887272, MAX_TICK = 887272;
const M = (b) => (1n << BigInt(b)) - 1n;

// ---- slot helpers ----
const tickSlot = (t) => BigInt(C.tickKey(t, 3));
const posKey = (owner, lo, hi) => (BigInt(owner) << 48n) | (BigInt.asUintN(24, BigInt(lo)) << 24n) | BigInt.asUintN(24, BigInt(hi));
const posSlot = (owner, lo, hi) => BigInt(ethers.keccak256(abi.encode(['bytes32', 'uint256'], [hex32(posKey(owner, lo, hi)), 11])));
const leafSlot = (t) => BigInt(C.wordKey(t >> 8, 8));
const secondSlot = (t) => BigInt(C.wordKey(((t >> 8) + 3466) >> 8, 10));

function unpackGS(v) {
  return { price: v & M(160), tick: C.asInt((v >> 160n) & M(24), 24), lastFee: (v >> 184n) & M(16),
    pluginConfig: (v >> 200n) & M(8), communityFee: (v >> 208n) & M(16), unlocked: (v >> 224n) & M(8) };
}
function packGS(g) {
  return BigInt(g.price) | (BigInt.asUintN(24, BigInt(g.tick)) << 160n) | (g.lastFee << 184n) | (g.pluginConfig << 200n) | (g.communityFee << 208n) | (g.unlocked << 224n);
}
// slot 9: nextTickGlobal int24 | prevTickGlobal int24 | liquidity uint128 | tickSpacing int24 | tickTreeRoot uint32
function unpack9(v) {
  return { next: C.asInt(v & M(24), 24), prev: C.asInt((v >> 24n) & M(24), 24), liq: (v >> 48n) & M(128), rest: v >> 176n };
}
function pack9(s) {
  return BigInt.asUintN(24, BigInt(s.next)) | (BigInt.asUintN(24, BigInt(s.prev)) << 24n) | (s.liq << 48n) | (s.rest << 176n);
}

async function setup(chain, rng) {
  const base = await C.setupBase(chain, rng);
  const n = await chain.provider.getTransactionCount(chain.me);
  const depAddr = ethers.getCreateAddress({ from: chain.me, nonce: n + 1 });
  const F = await L.deploy(chain, fA.abi, fA.bytecode, depAddr);
  await L.deploy(chain, dA.abi, dA.bytecode, await F.getAddress());
  const PF = await L.deploy(chain, pfA.abi, pfA.bytecode, await F.getAddress());
  await (await F.setDefaultPluginFactory(await PF.getAddress())).wait();
  const V = await L.deploy(chain, vA.abi, vA.bytecode, VAULT);
  await (await F.setVaultFactory(await V.getAddress())).wait();
  await (await F.setDefaultCommunityFee(100)).wait(); // 10% of swap fees to the vault
  await (await F.createPool(base.U, base.W, '0x')).wait();
  const pool = lc(await F.poolByPair(base.U, base.W));
  const P = new ethers.Contract(pool, pA.abi, await chain.provider.getSigner(0));
  await (await P.initialize(C.sqrtPriceFor(2500, base.U, base.W))).wait();
  const plugin = lc(await P.plugin());
  const ctx = { ...base, pool, plugin, positions: [], ticks: new Set() };
  ctx.namer = C.makeNamer(base, { pool, vault: VAULT, replayer: REPLAYER });
  ctx.namer.label.set(pool, 'algebra');
  ctx.namer.label.set(plugin, 'plugin');
  for (const [k, nm] of [[0, 'totalFeeGrowth0'], [1, 'totalFeeGrowth1'], [2, 'globalState'], [4, 'communityFeePending|lastFeeTransferTs'],
    [5, 'pluginFeePending'], [6, 'plugin'], [7, 'communityVault'], [9, 'next/prevTickGlobal|liquidity|tickSpacing|treeRoot'], [12, 'reserves']]) ctx.namer.add(pool, k, nm);
  const tick = unpackGS(await chain.getSlot(pool, 2n)).tick;
  const b = Math.floor(tick / SPACING) * SPACING;
  for (let k = 1; k <= 14; k++) {
    const lo = b - SPACING * k * 6, hi = b + SPACING * k * 5;
    await (await base.traderC.mintAlgebra(pool, lo, hi, C.Q(16) * BigInt(rng.int(1, 4)))).wait();
    registerPosition(ctx, base.trader, lo, hi);
  }
  ctx.tickNow = tick;
  return ctx;
}

function registerPosition(ctx, owner, lo, hi) {
  for (const t of [lo, hi]) {
    if (ctx.ticks.has(t)) continue;
    ctx.ticks.add(t);
    for (const [j, nm] of ['liquidityTotal', 'liquidityDelta|prev|next', 'outerFeeGrowth0', 'outerFeeGrowth1'].entries()) ctx.namer.add(ctx.pool, tickSlot(t) + BigInt(j), `tick.${nm}`);
    ctx.namer.add(ctx.pool, leafSlot(t), 'tickTable');
    ctx.namer.add(ctx.pool, secondSlot(t), 'tickTreeSecondLayer');
  }
  const ps = posSlot(owner, lo, hi);
  for (const [j, nm] of ['liquidity', 'innerFeeGrowth0', 'innerFeeGrowth1', 'fees0|fees1'].entries()) ctx.namer.add(ctx.pool, ps + BigInt(j), `position.${nm}`);
  if (!ctx.positions.find((x) => x.lo === lo && x.hi === hi)) ctx.positions.push({ owner: lc(owner), lo, hi });
}

const copiedAccounts = (ctx) => [ctx.pool, ctx.plugin, ctx.U, ctx.W, ...ctx.refs.map((r) => r.addr)];
async function initCopy(copy, ctx) { ctx.replayerCode = '0x' + L.helpers().Replayer.evm.deployedBytecode.object; }

// Known-unknown slots in "fields" mode (strict check treats them as unknown).
function policyUnknown(ctx) {
  const m = new Map();
  if (!ctx.variant.startsWith('fields')) return m;
  const s = new Set([hex32(0), hex32(1), hex32(4), hex32(5)]);
  for (const t of ctx.ticks) for (const j of [2n, 3n]) s.add(hex32(tickSlot(t) + j));
  m.set(ctx.pool, s);
  // "fields": the plugin's whole storage is unknown (no event describes it).
  if (ctx.variant === 'fields') m.set(ctx.plugin, 'ALL');
  return m;
}

function slotName(ctx, a, k) {
  return ctx.namer.name(a, k, (addr, slot) => {
    if (addr === ctx.plugin) return BigInt(slot) < 8n ? `slot${BigInt(slot)}` : 'timepoints';
    return 'other';
  });
}
const label = (ctx, a) => ctx.namer.label.get(a) ?? a;
const checkSpecs = (ctx) => C.checkSpecs(ctx, (tin, tout) => L.hop(2, ctx.pool, tin, tout));

async function randomOp(rng, ctx) {
  const ti = traderIface();
  const r = rng.next();
  const T = ctx.trader;
  const zeroIsU = BigInt(ctx.U) < BigInt(ctx.W);
  if (r < 0.66) {
    const usd = rng.logBig(1n, 3_000_000n);
    const inU = rng.next() < 0.5;
    const zeroForOne = inU === zeroIsU;
    const amtIn = inU ? usd * C.Q(6) : (usd * C.Q(18)) / 2500n;
    if (rng.next() < 0.15) {
      const out = inU ? (usd * C.Q(18)) / 2600n : (usd * C.Q(6) * 9n) / 10n;
      return { kind: 'swapExactOut', to: T, data: ti.encodeFunctionData('swapV3', [ctx.pool, zeroForOne, -out, 0]) };
    }
    return { kind: 'swap', to: T, data: ti.encodeFunctionData('swapV3', [ctx.pool, zeroForOne, amtIn, 0]) };
  }
  if (r < 0.74) {
    const inU = rng.next() < 0.5;
    const amt = inU ? rng.logBig(1n, 50_000n) * C.Q(6) : (rng.logBig(1n, 50_000n) * C.Q(18)) / 2500n;
    return { kind: 'donate', to: T, data: ti.encodeFunctionData('donate', [inU ? ctx.U : ctx.W, ctx.pool, amt]) };
  }
  if (r < 0.83) {
    const b = Math.floor((ctx.tickNow ?? 0) / SPACING) * SPACING;
    const lo = b - SPACING * rng.int(-20, 120), hi = lo + SPACING * rng.int(1, 150);
    const liq = C.Q(14) * BigInt(rng.int(1, 300));
    return { kind: 'mint', to: T, data: ti.encodeFunctionData('mintAlgebra', [ctx.pool, lo, hi, liq]), onSuccess: () => registerPosition(ctx, ctx.trader, lo, hi) };
  }
  if (r < 0.91 && ctx.positions.length) {
    const p = rng.pick(ctx.positions);
    const liq = ctx.posLiq?.get(`${p.lo}:${p.hi}`) ?? 0n;
    if (liq > 0n) {
      const amt = rng.next() < 0.3 ? liq : (liq * BigInt(rng.int(1, 60))) / 100n;
      return { kind: 'burn', to: T, data: ti.encodeFunctionData('burnAlgebra', [ctx.pool, p.lo, p.hi, amt, rng.next() < 0.5]) };
    }
  }
  if (r < 0.95 && ctx.positions.length) {
    const p = rng.pick(ctx.positions);
    return { kind: 'collect', to: T, data: ti.encodeFunctionData('collectV3', [ctx.pool, p.lo, p.hi]) };
  }
  const a0 = rng.logBig(1n, 10n ** 12n), a1 = rng.logBig(1n, 10n ** 12n);
  return { kind: 'flash', to: T, data: ti.encodeFunctionData('flashV3', [ctx.pool, a0, a1]) };
}

// ---- replay helper (same idea as v3family.js) ----
async function replayCall(copy, ctx, blk, from, to, data, keep) {
  const ov = { [REPLAYER]: { code: ctx.replayerCode } };
  for (const t of [ctx.U, ctx.W]) ov[t] = { stateDiff: { [C.tokBal(REPLAYER)]: hex32(10n ** 40n) } };
  const bo = { time: '0x' + blk.timestamp.toString(16), number: '0x' + blk.number.toString(16) };
  const tx = { from, to, data, gas: '0x1c9c380' };
  const ct = await copy.rpc('debug_traceCall', [tx, 'latest', { tracer: 'callTracer', stateOverrides: ov, blockOverrides: bo }]);
  if (ct.error) return { ok: false, error: ct.error + ' ' + (ct.revertReason ?? '') };
  const d = await copy.rpc('debug_traceCall', [tx, 'latest', { tracer: 'prestateTracer', tracerConfig: { diffMode: true }, stateOverrides: ov, blockOverrides: bo }]);
  const writes = [];
  for (const a of keep) {
    const A = Object.keys(d.post).find((x) => lc(x) === a), Ap = Object.keys(d.pre).find((x) => lc(x) === a);
    const post = (A && d.post[A].storage) || {}, pre = (Ap && d.pre[Ap].storage) || {};
    for (const [k, v] of Object.entries(post)) writes.push([a, k, BigInt(v)]);
    for (const k of Object.keys(pre)) if (!(k in post)) writes.push([a, k, 0n]);
  }
  return { ok: true, output: ct.output, writes };
}

// Slots a Mint/Burn/Collect/Flash can change (for node re-reads, "fields").
function reReadSlots(ctx, ev) {
  const s = [0n, 1n, 2n, 4n, 5n, 9n, 12n];
  if (ev.lo !== undefined) {
    const sorted = [...ctx.ticks].sort((x, y) => x - y);
    for (const t of [ev.lo, ev.hi]) {
      for (const j of [0n, 1n, 2n, 3n]) s.push(tickSlot(t) + j);
      s.push(leafSlot(t), secondSlot(t));
    }
    // Ticks form a linked list (prev/next links); adding or removing one
    // changes its neighbours' links. Re-read the link slot of every tick we
    // know of (plus the two end markers): simpler than tracking which ticks
    // are active, and it costs slots, not extra re-read events.
    for (const t of [...sorted, MIN_TICK, MAX_TICK]) s.push(tickSlot(t) + 1n);
    for (const j of [0n, 1n, 2n, 3n]) s.push(posSlot(ev.owner, ev.lo, ev.hi) + j);
  }
  return s;
}

async function applyLogs(copy, logs, blk, ctx, io) {
  const byTx = new Map();
  for (const lg of logs) { if (!byTx.has(lg.transactionHash)) byTx.set(lg.transactionHash, []); byTx.get(lg.transactionHash).push(lg); }
  for (const txLogs of byTx.values()) {
    const poolLogs = txLogs.filter((l) => lc(l.address) === ctx.pool);
    const evs = poolLogs.map((l) => { try { return poolIface.parseLog(l); } catch { return null; } });
    for (const ev of evs) io.countEvent('Pool.' + (ev?.name ?? 'unknown'));
    for (const l of txLogs) if (lc(l.address) !== ctx.pool && lc(l.address) !== ctx.plugin && !ctx.tokens[lc(l.address)]) io.countEvent('Other.' + l.address);
    for (const l of txLogs) if (lc(l.address) === ctx.plugin) io.countEvent('Plugin.event');
    if (ctx.variant.startsWith('fields')) await fieldsTx(copy, ctx, io, blk, evs, txLogs);
    else await replayTx(copy, ctx, io, blk, evs);
    for (const log of txLogs) if (ctx.tokens[lc(log.address)]) await C.applyTokenLog(copy, log, ctx, io);
  }
  if (ctx.pendingReRead) {
    await io.reRead(ctx.pool, [...ctx.pendingReRead.slots], ctx.pendingReRead.reasons.join('+'));
    ctx.pendingReRead = null;
  }
  ctx.tickNow = unpackGS(await copy.getSlot(ctx.pool, 2n)).tick;
  ctx.posLiq = new Map();
  for (const p of ctx.positions) ctx.posLiq.set(`${p.lo}:${p.hi}`, await copy.getSlot(ctx.pool, posSlot(p.owner, p.lo, p.hi)));
}

// ---- "replay" variant ----
async function replayTx(copy, ctx, io, blk, evs) {
  const ri = replayerIface();
  const keep = [ctx.pool, ctx.plugin];
  // A swap's Swap event comes with a SwapFee event; Mint/Burn/Collect/Flash alone.
  for (const ev of evs) {
    if (!ev) continue;
    const a = ev.args;
    let r = null, check = () => true, name = ev.name;
    if (name === 'Swap') {
      // Direction: coin0 paid in = zeroForOne; if no coins moved (0/0), price fell = zeroForOne.
      const priceBefore = unpackGS(await copy.getSlot(ctx.pool, 2n)).price;
      const zeroForOne = a.amount0 !== 0n || a.amount1 !== 0n ? a.amount0 > 0n : a.price < priceBefore;
      const amtIn = zeroForOne ? a.amount0 : a.amount1, amtOut = zeroForOne ? -a.amount1 : -a.amount0;
      const HUGE = 1n << 200n;
      let done = false;
      for (const [mode, amount, limit] of [['exactIn', amtIn, 0n], ['exactOut', -amtOut, 0n], ['exactIn+limit', amtIn, a.price], ['exactOut+limit', -amtOut, a.price], ['toPrice', HUGE, a.price], ['tinyIn', 1n, a.price], ['tinyOut', -1n, a.price]]) {
        const rr = await replayCall(copy, ctx, blk, ctx.me, REPLAYER, ri.encodeFunctionData('swap', [ctx.pool, zeroForOne, amount, limit]), keep);
        if (!rr.ok) continue;
        const [x0, x1] = abi.decode(['int256', 'int256'], rr.output);
        if (x0 !== a.amount0 || x1 !== a.amount1) continue;
        const w2 = rr.writes.find(([acc, k]) => acc === ctx.pool && BigInt(k) === 2n);
        const gs = unpackGS(w2 ? w2[2] : await copy.getSlot(ctx.pool, 2n));
        const w9 = rr.writes.find(([acc, k]) => acc === ctx.pool && BigInt(k) === 9n);
        const s9 = unpack9(w9 ? w9[2] : await copy.getSlot(ctx.pool, 9n));
        if (gs.price !== a.price || gs.tick !== Number(a.tick) || s9.liq !== a.liquidity) continue;
        io.replay('Swap:' + mode);
        for (const [acc, k, v] of rr.writes) await copy.setSlot(acc, k, v);
        done = true;
        break;
      }
      if (!done) { io.replay('Swap:FAILED'); await io.reRead(ctx.pool, [0n, 1n, 2n, 4n, 5n, 9n, 12n], 'Swap:replayFailed'); }
      continue;
    }
    if (name === 'Mint') {
      registerPosition(ctx, a.owner, Number(a.bottomTick), Number(a.topTick));
      r = await replayCall(copy, ctx, blk, ctx.me, REPLAYER, ri.encodeFunctionData('mintAlgebra', [ctx.pool, a.owner, a.bottomTick, a.topTick, a.liquidityAmount]), keep);
      check = (o) => { const [x0, x1, l] = abi.decode(['uint256', 'uint256', 'uint128'], o); return x0 === a.amount0 && x1 === a.amount1 && l === a.liquidityAmount; };
    } else if (name === 'Burn') {
      r = await replayCall(copy, ctx, blk, a.owner, ctx.pool, poolIface.encodeFunctionData('burn', [a.bottomTick, a.topTick, a.liquidityAmount, '0x']), keep);
      check = (o) => { const [x0, x1] = abi.decode(['uint256', 'uint256'], o); return x0 === a.amount0 && x1 === a.amount1; };
    } else if (name === 'Collect') {
      r = await replayCall(copy, ctx, blk, a.owner, ctx.pool, poolIface.encodeFunctionData('collect', [a.recipient, a.bottomTick, a.topTick, a.amount0, a.amount1]), keep);
      check = (o) => { const [x0, x1] = abi.decode(['uint128', 'uint128'], o); return x0 === a.amount0 && x1 === a.amount1; };
    } else if (name === 'Flash') {
      r = await replayCall(copy, ctx, blk, ctx.me, REPLAYER, ri.encodeFunctionData('flash', [ctx.pool, a.amount0, a.amount1, a.paid0, a.paid1]), keep);
    } else {
      continue; // SwapFee, BurnFee, ExcessTokens, Fee, PluginConfig: side effects of the action replayed above
    }
    if (r.ok && check(r.output)) { io.replay(name); for (const [acc, k, v] of r.writes) await copy.setSlot(acc, k, v); }
    else {
      io.replay(name + ':FAILED');
      const ev2 = a.bottomTick !== undefined ? { owner: a.owner, lo: Number(a.bottomTick), hi: Number(a.topTick) } : {};
      await io.reRead(ctx.pool, reReadSlots(ctx, ev2), name + ':replayFailed');
    }
  }
}

// ---- "fields" variant ----
async function fieldsTx(copy, ctx, io, blk, evs, txLogs) {
  for (const ev of evs) {
    if (!ev) continue;
    const a = ev.args;
    const gs = unpackGS(await copy.getSlot(ctx.pool, 2n));
    if (ev.name === 'Swap') {
      if (ctx.variant === 'fields-plugin') {
        // Run the plugin's beforeSwap hook as the pool would (pool state = pre-swap).
        const zto = a.amount0 > 0n;
        const r = await replayCall(copy, ctx, blk, ctx.pool, ctx.plugin,
          pluginIface.encodeFunctionData('beforeSwap', [a.sender, a.recipient, zto, zto ? a.amount0 : a.amount1, 0, false, '0x']), [ctx.plugin]);
        if (r.ok) { io.replay('plugin.beforeSwap'); for (const [acc, k, v] of r.writes) await copy.setSlot(acc, k, v); }
        else { io.replay('plugin.beforeSwap:FAILED ' + r.error); }
      }
      gs.price = a.price; gs.tick = Number(a.tick);
      await copy.setSlot(ctx.pool, 2n, packGS(gs));
      const s9 = unpack9(await copy.getSlot(ctx.pool, 9n));
      s9.liq = a.liquidity;
      // prev/next active tick around the new price, from our own tick list
      // (only ticks that still hold liquidity).
      const active = [];
      for (const t of ctx.ticks) if ((await copy.getSlot(ctx.pool, tickSlot(t))) > 0n) active.push(t);
      active.sort((x, y) => x - y);
      s9.prev = Math.max(MIN_TICK, ...active.filter((t) => t <= gs.tick));
      s9.next = Math.min(MAX_TICK, ...active.filter((t) => t > gs.tick));
      await copy.setSlot(ctx.pool, 9n, pack9(s9));
      await addReserves(copy, ctx, a.amount0, a.amount1);
    } else if (ev.name === 'ExcessTokens') {
      await addReserves(copy, ctx, a.amount0, a.amount1);
    } else if (ev.name === 'Fee') {
      gs.lastFee = a.fee; await copy.setSlot(ctx.pool, 2n, packGS(gs));
    } else if (ev.name === 'PluginConfig') {
      gs.pluginConfig = a.newPluginConfig; await copy.setSlot(ctx.pool, 2n, packGS(gs));
    } else if (ev.name === 'CommunityFee') {
      gs.communityFee = a.communityFeeNew; await copy.setSlot(ctx.pool, 2n, packGS(gs));
    } else if (['Mint', 'Burn', 'Collect', 'Flash'].includes(ev.name)) {
      if (ev.name === 'Mint') registerPosition(ctx, a.owner, Number(a.bottomTick), Number(a.topTick));
      const ev2 = a.bottomTick !== undefined ? { owner: a.owner, lo: Number(a.bottomTick), hi: Number(a.topTick) } : {};
      ctx.pendingReRead ??= { slots: new Set(), reasons: [] };
      for (const s of reReadSlots(ctx, ev2)) ctx.pendingReRead.slots.add(s);
      ctx.pendingReRead.reasons.push(ev.name);
    }
  }
  // community fees paid out to the vault leave the reserves
  for (const l of txLogs) {
    if (ctx.tokens[lc(l.address)] && l.topics[0] === C.TRANSFER && lc('0x' + l.topics[1].slice(26)) === ctx.pool && lc('0x' + l.topics[2].slice(26)) === VAULT) {
      const v = BigInt(l.data);
      const is0 = BigInt(l.address) === BigInt(BigInt(ctx.U) < BigInt(ctx.W) ? ctx.U : ctx.W);
      await addReserves(copy, ctx, is0 ? -v : 0n, is0 ? 0n : -v);
    }
  }
}
async function addReserves(copy, ctx, d0, d1) {
  const v = await copy.getSlot(ctx.pool, 12n);
  const r0 = BigInt.asUintN(128, (v & M(128)) + d0), r1 = BigInt.asUintN(128, (v >> 128n) + d1);
  await copy.setSlot(ctx.pool, 12n, r0 | (r1 << 128n));
}

function swapOp(ctx) {
  const zeroIsU = BigInt(ctx.U) < BigInt(ctx.W);
  return { to: ctx.trader, data: traderIface().encodeFunctionData('swapV3', [ctx.pool, zeroIsU, 200_000n * C.Q(6), 0]) };
}

module.exports = { setup, copiedAccounts, initCopy, policyUnknown, slotName, label, checkSpecs, randomOp, applyLogs, swapOp };
